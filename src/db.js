// Supabase helpers: ensure user, log items, compute today's total.
const { createClient } = require("@supabase/supabase-js");
const { FOODS, FOOD_BY_ID } = require("./foods.js");
const { matchRows } = require("./correctionContext.js");
const { guardItems } = require("./proteinGuard.js");
const { contextGuard, contentTokens } = require("./contextGuard.js");
const { logGapEvent } = require("./gapLogger.js");
const { rerankReference, rerankTarget } = require("./rerank.js");
const { foodKey: memFoodKey, worthRemembering, toMemoryRow, applyMemory } = require("./correctionMemory.js");
const { WINDOW_MS, MAX_EXCHANGES } = require("./conversationMemory.js");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const MEAL_GAP_MS = 45 * 60 * 1000; // PRD: messages within 45 min = same meal

// Every real column of user_logs. Resolution attaches transient flags to the
// same row objects (stated, assumed, rerankMatched, memoryApplied, …), and
// anything not listed here is dropped before the insert rather than sent to
// Postgres as a column that does not exist. `id` and `logged_at` are omitted
// deliberately so the database assigns them.
const USER_LOG_COLUMNS = Object.freeze([
  "phone_number", "food_name", "matched_db_id", "quantity", "unit",
  "kcal", "protein", "carbs", "fat", "fiber",
  "meal_time", "is_estimate", "date", "day_seq",
]);

function toUserLogInsertRow(row) {
  const out = {};
  for (const col of USER_LOG_COLUMNS) {
    if (row[col] !== undefined) out[col] = row[col];
  }
  return out;
}

// Logs are plain files on disk (~/Library/Logs) and the repo is public — a raw
// phone number in a log line is user PII sitting in cleartext. Same masking the
// metrics dashboard uses: +91••••••1234.
const maskPhone = (p) => String(p || "").replace(/^(\+\d{2})\d+(\d{4})$/, "$1••••••$2");

// Upserts the user; returns true when the phone number is brand-new (first
// contact ever) so the caller can show a one-time welcome.
async function ensureUser(phone) {
  const { data, error } = await supabase.from("users")
    .upsert({ phone_number: phone }, { onConflict: "phone_number", ignoreDuplicates: true })
    .select("phone_number");
  if (error) { console.error("SUPABASE UPSERT USER FAILED:", error.message); return false; }
  return (data || []).length > 0;
}

// Fetch the user's name + goal + how many times we've nudged them to set one.
// A goal is "set" only when goal_protein is non-null (goal_kcal has a legacy
// default of 2000, so it can't distinguish set-vs-unset on its own).
const profileFields = "name, goal_kcal, goal_protein, nudge_count, tdee_profile";
const isMissingConversationStateColumn = error => {
  const message = String(error && error.message || "");
  return /conversation_state/i.test(message)
    && (error && error.code === "42703" || /does not exist|undefined column/i.test(message));
};

async function getProfile(phone) {
  let { data, error } = await supabase.from("users")
    .select(`${profileFields}, conversation_state`)
    .eq("phone_number", phone).maybeSingle();
  if (isMissingConversationStateColumn(error)) {
    ({ data, error } = await supabase.from("users")
      .select(profileFields)
      .eq("phone_number", phone).maybeSingle());
  }
  if (error) { console.error("getProfile:", error.message); return {}; }
  const p = data || {};
  return { ...p, hasGoal: p.goal_protein != null };
}

async function saveConversationState(phone, state, client = supabase) {
  const { error } = await client.from("users").upsert(
    { phone_number: phone, conversation_state: state || {} },
    { onConflict: "phone_number" }
  );
  if (error) {
    console.error("saveConversationState:", error.message);
    return false;
  }
  return true;
}

async function claimConversationState(phone, nonce, client = supabase) {
  if (typeof phone !== "string" || !phone || typeof nonce !== "string" || !nonce) return false;
  const { data, error } = await client.rpc(
    "claim_conversation_state",
    { p_phone: phone, p_nonce: nonce }
  );
  if (error) {
    console.error("claimConversationState:", error.message);
    return false;
  }
  return data === true;
}

async function clearConversationStateIfUnchanged(phone, rawState, client = supabase) {
  if (!rawState || typeof rawState !== "object") return false;
  const { data, error } = await client.rpc(
    "clear_conversation_state_if_match",
    { p_phone: phone, p_state: rawState }
  );
  if (error) {
    console.error("clearConversationStateIfUnchanged:", error.message);
    return false;
  }
  return data === true;
}

async function recentConversation(phone, now = new Date(), client = supabase) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return [];
  const since = new Date(now.getTime() - WINDOW_MS).toISOString();
  const { data, error } = await client.from("message_log")
    .select("body, reply, media, at")
    .eq("phone_number", phone)
    .gte("at", since)
    .lte("at", now.toISOString())
    .order("at", { ascending: false })
    .order("id", { ascending: false })
    .limit(MAX_EXCHANGES);
  if (error) {
    console.error("recentConversation:", error.message);
    return [];
  }
  return Array.isArray(data)
    ? data.map(({ body, reply, media, at }) => ({ body, reply, media, at })).reverse()
    : [];
}

// Save name and/or goal from a set_profile message. Only writes provided fields.
async function saveProfile(phone, { name, goal_kcal, goal_protein }) {
  const patch = { phone_number: phone };
  if (name) patch.name = name;
  if (goal_kcal) patch.goal_kcal = goal_kcal;
  if (goal_protein) patch.goal_protein = goal_protein;
  const { error } = await supabase.from("users").upsert(patch, { onConflict: "phone_number" });
  if (error) console.error("saveProfile:", error.message);
}

async function saveTdeeProfile(phone, tdeeProfile) {
  const { error } = await supabase.from("users").upsert(
    { phone_number: phone, tdee_profile: tdeeProfile || {} },
    { onConflict: "phone_number" }
  );
  if (error) {
    console.error("saveTdeeProfile:", error.message);
    return false;
  }
  return true;
}

// Fire-and-forget nudge counter bump (drives the "set a goal" prompt cap).
function bumpNudge(phone, current) {
  supabase.from("users").update({ nudge_count: (current || 0) + 1 })
    .eq("phone_number", phone).then(({ error }) => { if (error) console.error("bumpNudge:", error.message); });
}

// Approximate grams in one serving of each unit — used to convert weight-based
// logging ("100g X") into calories when a food has no explicit `g` field.
const UNIT_GRAMS = {
  bowl: 150, katori: 120, cup: 150, plate: 200, glass: 200, serving: 150,
  medium: 150, slice: 30, scoop: 30, tbsp: 15, tsp: 5, handful: 30,
  fillet: 100, bar: 50, pack: 70, "100g": 100, white: 33, egg: 55, can: 330, piece: 60,
  half: 2, stick: 70,
};

// Default macro split for estimated foods where macros are unknown:
// 50% carbs / 25% protein / 25% fat by energy (user-set policy, 2026-07-15).
// The flat split is nonsense for whole categories — it billed a Munch bar at
// 6g protein. Obvious ones get a sane energy profile; everything else keeps the
// user-set default.
const MACRO_PROFILES = [
  { re: /chocolate|candy|toffee|barfi|halwa|jalebi|gulab|rasgulla|sweet|dessert|ice ?cream|cake|pastry|cookie|biscuit|chocos|cornflakes|cereal|juice|soda|cola|syrup|jam|honey|sugar/,
    p: 0.05, c: 0.75, f: 0.20 },
  { re: /chips|fries|namkeen|\bsev\b|mixture|papad|wafer|crisps/, p: 0.07, c: 0.50, f: 0.43 },
  { re: /chicken|mutton|gosht|keema|fish|prawn|\begg|paneer|tofu|soya|whey|protein|kebab|tikka/,
    p: 0.35, c: 0.25, f: 0.40 },
];
const splitMacros = (kcal, name = "") => {
  const p = MACRO_PROFILES.find(m => m.re.test(String(name).toLowerCase()))
    || { p: 0.25, c: 0.5, f: 0.25 };
  return {
    protein: +(kcal * p.p / 4).toFixed(1),
    carbs: +(kcal * p.c / 4).toFixed(1),
    fat: +(kcal * p.f / 9).toFixed(1),
  };
};

// Exact-alias rescue: the LLM occasionally returns matched_db_id null for a
// food whose alias is right there in the map. Catching it here keeps the item
// off the fuzzy INDB path entirely.
const ALIAS_TO_ID = new Map();
for (const f of FOODS) {
  ALIAS_TO_ID.set(f.name.toLowerCase(), f.id);
  for (const a of f.aliases) ALIAS_TO_ID.set(a.toLowerCase(), f.id);
}
// Exact match first; only if that misses do we try the plural the LLM often
// returns ("idlis", "parathas", "momos"). Falling back rather than stripping
// up front keeps foods whose singular ends in -s ("chips") matching themselves.
function aliasRescue(name) {
  const n = String(name || "").trim().toLowerCase();
  if (!n) return null;
  const exact = ALIAS_TO_ID.get(n);
  if (exact != null) return exact;
  if (n.endsWith("es") && ALIAS_TO_ID.has(n.slice(0, -2))) return ALIAS_TO_ID.get(n.slice(0, -2));
  if (n.endsWith("s") && ALIAS_TO_ID.has(n.slice(0, -1))) return ALIAS_TO_ID.get(n.slice(0, -1));
  return null;
}

// Bare category words span a huge calorie range ("sabji" is anywhere from 80 to
// 250 kcal). We still log a sensible default rather than dead-end, but the user
// must be told which one we picked — never a silent direct match.
const GENERIC_TERMS = new Set([
  "sabji", "sabzi", "subzi", "sabjee", "curry", "gravy", "sweet", "mithai",
  "dessert", "snack", "namkeen", "juice", "shake", "chutney", "salad",
]);

// INDB matching is fuzzy, so short or generic queries pull in recipes that
// merely contain the word ("eggs" -> "Mayonnaise without eggs", 1274 kcal/serving;
// "sabji" -> a specific bhindi fry). Two deterministic checks before we trust a hit.
function acceptableRef(query, refName) {
  const q = contentTokens(query);
  const r = String(refName || "").toLowerCase();
  if (!q.length) return false;
  // 1. The recipe explicitly excludes what the user asked for.
  const negates = q.some(w => new RegExp(
    `\\b(?:without|no|sans|free\\s+of)\\s+(?:\\w+\\s+){0,2}?${w}\\b|\\b${w}\\s*-?\\s*(?:free|less)\\b`
  ).test(r));
  if (negates) return false;
  // 2. The recipe must be mostly about the query. Alternate names live in
  //    parentheses, so those count as evidence but never as unexplained words.
  const present = q.filter(w => r.includes(w)).length;
  const absent = contentTokens(r.replace(/\(.*?\)/g, " ")).filter(w => !q.includes(w)).length;
  return present > 0 && absent <= present;
}

// Serving-word floor: "platter"/"thali"/"combo" on a per-piece food means a
// multi-piece serving, not one piece ("chicken tandoor platter" was served as
// 1 tikka piece = 55 kcal). No explicit count from the user -> assume 4 pieces,
// shown transparently in the reply so one message corrects it.
const SERVING_WORDS = /\b(platter|thali|combo|full plate|meal box)\b/i;
const PIECE_UNITS = new Set(["piece", "stick", "slice", "fillet"]);

// Convert a parsed item into a log row with resolved nutrition + 4-tier fallback.
// Wrapper applies user-stated PROTEIN ("yogurt was 22g protein") on top of any
// resolution path — the user's number replaces ours, kcal and the rest stay.
function resolveItem(item) {
  const row = resolveItemBase(item);
  const statedP = Number(item.stated_protein);
  if (statedP > 0 && statedP <= 200) {
    const q = /\d\s*(g|ml)$/.test(String(row.unit || "")) ? 1 : (Number(row.quantity) || 1);
    const newP = +(statedP * q).toFixed(1);
    // Keep the 4/4/9 energy identity honest: protein energy changed, so carbs
    // and fat absorb the remaining calories in their existing ratio. If the
    // stated protein alone exceeds the calories, the calories were the wrong
    // number — re-derive kcal from the macros instead.
    const remaining = row.kcal - 4 * newP;
    const curCF = 4 * Number(row.carbs || 0) + 9 * Number(row.fat || 0);
    if (remaining >= 0 && curCF > 0) {
      const sc = remaining / curCF;
      row.carbs = +(row.carbs * sc).toFixed(1);
      row.fat = +(row.fat * sc).toFixed(1);
    } else if (remaining > 0 && curCF === 0) {
      // Unknown food with stated kcal + protein: the leftover energy is real —
      // fill carbs/fat at a typical 60/40 energy split rather than zeros.
      row.carbs = +(remaining * 0.6 / 4).toFixed(1);
      row.fat = +(remaining * 0.4 / 9).toFixed(1);
    } else if (remaining < 0) {
      row.kcal = Math.round(4 * newP + curCF);
    }
    row.protein = newP;
    row.stated = true;
    row.assumed = false;
    row.is_estimate = false;
  }
  return row;
}

function resolveItemBase(item) {
  const food = item.matched_db_id ? FOOD_BY_ID[item.matched_db_id] : null;
  let grams = Number(item.grams);

  // User-stated calories ("4 fish sticks have 230 cal") are ground truth: they
  // override the DB value and skip the INDB cross-reference (`stated` flag).
  const statedKcal = Number(item.stated_kcal);
  if (statedKcal > 0 && statedKcal <= 2000) {
    const q0 = Number(item.quantity);
    const qs = Number.isFinite(q0) && q0 > 0 ? Math.min(q0, 30) : 1;
    // Macros scale with the user's kcal so protein can't stay at the DB's level
    // when the user says the food is a third of the DB's calories.
    const ratio = food && food.kcal > 0 ? statedKcal / food.kcal : 0;
    return {
      food_name: item.food_name || (food ? food.name : "meal"),
      matched_db_id: food ? food.id : null, quantity: qs, unit: food ? food.unit : "serving",
      kcal: Math.round(statedKcal * qs),
      ...(food
        ? { protein: +(food.p * ratio * qs).toFixed(1), carbs: +(food.c * ratio * qs).toFixed(1),
            fat: +(food.f * ratio * qs).toFixed(1), fiber: +((food.fb || 0) * ratio * qs).toFixed(1) }
        : { ...splitMacros(statedKcal * qs, item.food_name), fiber: 0 }),
      is_estimate: false, stated: true,
      userSaid: item.food_name, assumed: false,
    };
  }
  // Raw/dry-weight logging (meal-preppers weigh uncooked). Grains/legumes gain
  // water when cooked (raw is denser, factor > 1); meat loses water (factor < 1).
  const rw = item.raw && food && food.rawFactor ? food.rawFactor : 1;
  const rawTag = rw !== 1 ? " (raw)" : "";
  // Display name: strip a baked-in "(Cooked)" when we're showing "(raw)".
  const dName = food ? (rawTag ? food.name.replace(/\s*\(cooked\)/i, "") : food.name) : "";

  // Weight-based logging: scale nutrition by exact grams / serving-grams. This is
  // what makes "40g rice", "100g soya chunks", "200g chicken" accurate.
  if (food && grams > 0 && grams <= 2000) {
    const servingG = food.g || UNIT_GRAMS[food.unit] || 150;
    const s = (grams / servingG) * rw;
    return {
      food_name: `${grams}g ${dName}${rawTag}`, matched_db_id: food.id, quantity: 1, unit: `${grams}g`,
      kcal: Math.round(food.kcal * s), protein: +(food.p * s).toFixed(1),
      carbs: +(food.c * s).toFixed(1), fat: +(food.f * s).toFixed(1),
      fiber: +((food.fb || 0) * s).toFixed(1), is_estimate: true,
      userSaid: item.food_name, assumed: item.match_type !== "direct",
    };
  }

  // Accept any positive quantity (7 eggs, 4 roti), snapped to 0.5 steps and capped.
  const q = Number(item.quantity);
  let qty = Number.isFinite(q) && q > 0 ? Math.min(Math.round(q * 2) / 2, 30) : 1.0;
  // Guard: a big multiplier on a portion unit (bowl/cup/serving/100g) is almost
  // always a grams/parse misread ("100g" -> qty 100), not a real count. Cap at 5.
  // Countable units (piece/slice/medium/fillet...) keep large counts (20 rotis).
  const PORTION_UNITS = new Set(["bowl", "plate", "glass", "katori", "cup", "serving", "100g"]);
  if (food && PORTION_UNITS.has(food.unit) && qty > 5) qty = 5;
  // Same misread, but for a food we DIDN'T match: an unknown food has no unit,
  // so it always estimates per-serving. Nobody eats 30 servings of one dish —
  // a big count there is a gram weight the parser put in the wrong field
  // ("100g kaju curry" -> quantity 100 -> 30 x 300 = 9,000 kcal). Treat it as grams.
  if (!food && qty > 10 && !(grams > 0)) { grams = Math.min(qty, 2000); qty = 1; }
  if (food && qty === 0) qty = 0.5; // a matched food must log something, never 0
  const platter = !!food && PIECE_UNITS.has(food.unit)
    && SERVING_WORDS.test(String(item.food_name || "")) && qty <= 1;
  if (platter) qty = 4;

  if (food) {
    // Tier 1/2: direct or category DB match
    const m = qty * rw;
    return {
      food_name: `${dName}${rawTag}`, matched_db_id: food.id, quantity: qty, unit: food.unit,
      kcal: Math.round(food.kcal * m), protein: +(food.p * m).toFixed(1),
      carbs: +(food.c * m).toFixed(1), fat: +(food.f * m).toFixed(1),
      fiber: +((food.fb || 0) * m).toFixed(1),
      is_estimate: platter || item.match_type !== "direct" || item.portion_clarity !== "specified",
      userSaid: item.food_name, assumed: item.match_type !== "direct",
      portionNote: platter ? `assumed ${qty} ${food.unit}s for the platter — reply a count to fix`
        : item.portion_clarity !== "specified" ? `${qty} ${food.unit}` : null,
    };
  }
  // Tier 3: unknown food but the LLM knows it — use its per-serving estimate,
  // clamped so a hallucinated number can't poison a day. Tier 4: flat 300 floor.
  const est = Number(item.est_kcal);
  const perServing = Number.isFinite(est) && est > 0 ? Math.min(Math.max(Math.round(est), 20), 800) : 300;
  // Weight-based even for uncurated foods. Prefer the LLM's per-100g figure:
  // scaling a "standard serving" by grams/150 under-reports dense foods badly
  // (50g chocos came out 63 kcal against a real ~187).
  if (grams > 0 && grams <= 2000) {
    const per100 = Number(item.est_kcal_100g);
    if (Number.isFinite(per100) && per100 > 0 && per100 <= 900) {
      const kcal = Math.round(per100 * grams / 100);
      return {
        food_name: `${grams}g ${item.food_name || "meal"}`, matched_db_id: null, quantity: 1,
        unit: `${grams}g`, kcal, ...splitMacros(kcal, item.food_name), fiber: 0,
        is_estimate: true, userSaid: item.food_name, assumed: true,
      };
    }
    const s = grams / 150;
    return {
      food_name: `${grams}g ${item.food_name || "meal"}`, matched_db_id: null, quantity: 1,
      unit: `${grams}g`, kcal: Math.round(perServing * s), ...splitMacros(perServing * s, item.food_name), fiber: 0,
      is_estimate: true, userSaid: item.food_name, assumed: true,
    };
  }
  return {
    food_name: item.food_name || "meal", matched_db_id: null, quantity: qty, unit: "serving",
    kcal: Math.round(perServing * qty), ...splitMacros(perServing * qty, item.food_name), fiber: 0, is_estimate: true,
    userSaid: item.food_name, assumed: true,
  };
}

// Tier 2.5: fuzzy-match an unknown food against the INDB reference table
// (1,014 lab-derived Indian recipes). Fails safe: any error or no hit -> null,
// and the LLM's own estimate stands.
async function refLookup(name) {
  const { data, error } = await supabase.rpc("match_food", { q: name });
  if (error) { console.error("refLookup:", error.message); return null; }
  return data && data[0] ? data[0] : null;
}

// Edit-distance similarity for typo tolerance. ILIKE substring can't match
// "provalic"->"provilac" (internal vowel swap) or "yoghurt"->"yogurt"; trigrams
// score that swap poorly (~0.23). Levenshtein handles it (~0.75).
function editSim(a, b) {
  a = String(a || ""); b = String(b || "");
  const m = a.length, n = b.length;
  if (!m || !n) return 0;
  const dp = Array.from({ length: m + 1 }, (_, i) => i);
  for (let j = 1; j <= n; j++) {
    let prev = dp[0]; dp[0] = j;
    for (let i = 1; i <= m; i++) {
      const tmp = dp[i];
      dp[i] = Math.min(dp[i] + 1, dp[i - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return 1 - dp[m] / Math.max(m, n);
}
// One query token vs a name's tokens: substring counts full; else best edit-sim.
// Sub-3-char tokens ("o", "s") are skipped — "coffee".includes("o") would
// otherwise score a full match against every name with an "o" token.
function tokenSim(qTok, nameToks) {
  let best = 0;
  for (const n of nameToks) {
    if (n.length < 3) continue;
    if (n.includes(qTok) || qTok.includes(n)) return 1;
    const s = editSim(qTok, n);
    if (s > best) best = s;
  }
  return best;
}
// Average per-token best similarity — rewards matching more of the query well,
// so a close brand token isn't drowned out by generic "high protein" words.
function matchScore(qTokens, name) {
  const nameToks = contentTokens(name).filter(t => t.length >= 3);
  const qToks = (qTokens || []).filter(t => t.length >= 3);
  if (!nameToks.length || !qToks.length) return 0;
  let sum = 0;
  for (const q of qToks) sum += tokenSim(q, nameToks);
  return sum / qToks.length;
}
const FUZZY_FLOOR = 0.55; // tuned against real typos ("provalic", "epigamaiya")

// The full reference table cached in memory (~2.6k rows) for the fuzzy pass, so
// a miss doesn't re-page the table every time. Refreshed lazily every 10m.
let _refAll = { at: 0, rows: [] };
async function allRefRows() {
  if (_refAll.rows.length && Date.now() - _refAll.at < 10 * 60 * 1000) return _refAll.rows;
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("foods_reference").select("*").range(from, from + 999);
    if (error) { console.error("allRefRows:", error.message); break; }
    if (!data || !data.length) break;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  if (rows.length) _refAll = { at: Date.now(), rows };
  return _refAll.rows;
}

// High-recall retrieval for the LLM reranker. The strict match_food RPC gates on
// word_similarity > 0.75, which structurally rejects terse-query-vs-verbose-brand
// ("epigamia yogurt" never clears the bar against "Epigamia High Protein Greek
// Yogurt"). Tier 1: rows containing ALL query tokens (exact substring, fast).
// Tier 2: fuzzy edit-distance rank over the whole table — handles both terse
// misses and misspelled brands ("provalic"->"Provilac"), floating the closest
// brand token above generic "high protein" noise.
async function refCandidates(name, limit = 15) {
  const tokens = contentTokens(name).slice(0, 6);
  if (!tokens.length) return [];

  let andQ = supabase.from("foods_reference").select("*");
  for (const t of tokens) andQ = andQ.ilike("food_name", `%${t}%`);
  const { data, error } = await andQ.limit(limit);
  if (error) { console.error("refCandidates(and):", error.message); return []; }
  if (data && data.length) return data;

  const all = await allRefRows();
  return all
    .map(r => ({ r, s: matchScore(tokens, r.food_name) }))
    .filter(x => x.s >= FUZZY_FLOOR)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map(x => x.r);
}

// Tier 2.6: when the strict INDB match fails, retrieve loosely + let the LLM pick
// the genuine match (or reject all). Returns the chosen reference row or null.
// Cost guard: only spend the rerank LLM call when a candidate is a real overlap —
// either it contains ALL query tokens (exact substring) OR a token is a close
// trigram match to one of its tokens (typo tolerance: "provalic"~"provilac"). A
// weak coincidental match isn't worth a call; the estimate fallback handles it.
async function refRerank(query) {
  const candidates = await refCandidates(query);
  if (!candidates.length) return null;
  const toks = contentTokens(query);
  if (!toks.length) return null;
  const strong = candidates.some(c => {
    const n = String(c.food_name).toLowerCase();
    return toks.every(t => n.includes(t)) || matchScore(toks, c.food_name) >= FUZZY_FLOOR;
  });
  if (!strong) return null;
  return rerankReference(query, candidates);
}

// Some INDB serving values are whole-recipe yields, not one portion — trust the
// serving numbers only in a plausible range, else derive from per-100g (~150g serving).
function applyReference(row, ref, opts = {}) {
  const qty = row.quantity;
  const inRange = (k) => Number.isFinite(Number(k)) && k >= 20 && k <= 800;

  // Build the INDB candidate at a per-serving (1x) basis first.
  let perServing, p = 0, c = 0, f = 0, fb = 0, unit = row.unit;
  if (inRange(Number(ref.serving_kcal))) {
    perServing = Number(ref.serving_kcal);
    p = Number(ref.serving_protein || 0); c = Number(ref.serving_carbs || 0); f = Number(ref.serving_fat || 0);
    fb = Number(ref.serving_fibre || 0);
    unit = ref.serving_unit || "serving";
  } else if (Number(ref.kcal_100g) > 0) {
    perServing = Math.min(Math.max(Math.round(ref.kcal_100g * 1.5), 20), 800); // ~150g serving
    p = Number(ref.protein_100g || 0) * 1.5; c = Number(ref.carbs_100g || 0) * 1.5; f = Number(ref.fat_100g || 0) * 1.5;
    fb = Number(ref.fibre_100g || 0) * 1.5;
  } else {
    return; // no usable numbers — keep the LLM estimate
  }

  // Guardrail: row.kcal here is the LLM's own per-serving estimate x qty. If the
  // fuzzy match disagrees wildly (>2x or <0.5x), it's probably a wrong recipe
  // ("honey" -> "Honey cake", "jam" -> "Jam tart") — keep the LLM estimate.
  // Suspect arbitration passes trusted: token evidence replaces this check
  // (comparing INDB against the WRONG curated value would falsely reject).
  if (!opts.trusted) {
    const llmPerServing = row.kcal / qty;
    if (llmPerServing > 0 && (perServing > llmPerServing * 2 || perServing < llmPerServing * 0.5)) return;
  }

  row.kcal = Math.round(perServing * qty);
  row.protein = +(p * qty).toFixed(1);
  row.carbs = +(c * qty).toFixed(1);
  row.fat = +(f * qty).toFixed(1);
  row.fiber = +(fb * qty).toFixed(1);
  row.unit = unit;
  row.food_name = ref.food_name;
  row.refVerified = true;
}

// Resolve parsed items to nutrition rows (curated -> INDB -> estimate) without
// touching the log — shared by logMeal and query-intent previews.
async function resolveRows(parsed, opts = {}) {
  const items = parsed.items || [];
  // Deterministic nets before nutrition resolution (order matters): the context
  // guard may rematch or flag; the protein guard then nulls cross-protein
  // matches outright so they take the INDB path below.
  contextGuard(items);
  guardItems(items);
  // Exact curated alias beats anything fuzzy — never let a food the map already
  // knows reach INDB. Guard-tripped items keep their INDB route.
  for (const it of items) {
    if (!it || !it.food_name) continue;
    if (!it.matched_db_id && !it.protein_guard) {
      const id = aliasRescue(it.food_name);
      if (id) { it.matched_db_id = id; it.match_type = "direct"; }
    }
    // A generic word resolved to a specific dish is an assumption, not a match.
    if (it.matched_db_id && GENERIC_TERMS.has(String(it.food_name).trim().toLowerCase())) {
      it.match_type = "category";
    }
  }
  const rows = items.map(it => resolveItem(it));
  // Cross-reference unmatched foods against INDB (parallel, misses only).
  await Promise.all(rows
    .filter(r => !r.matched_db_id && !r.stated && r.food_name && r.food_name !== "meal")
    .map(async r => {
      const query = r.userSaid || r.food_name;
      const ref = await refLookup(r.food_name);
      // applyReference can silently reject (its own >2x estimate-disagreement
      // guard). Only stop here if it ACTUALLY applied (refVerified) — otherwise
      // fall through to the rerank, which is LLM-verified and bypasses that guard.
      if (ref && acceptableRef(query, ref.food_name)) {
        applyReference(r, ref);
        if (r.refVerified) return;
      }
      // Strict INDB missed (or was rejected). Retrieve loosely and let the LLM
      // pick the genuine match — this resolves terse-query-vs-verbose-brand
      // ("epigamia yogurt" -> "Epigamia Greek Yogurt (Plain)"). The rerank IS the
      // verification, so apply as trusted (skips the estimate-disagreement guard).
      const picked = await refRerank(query);
      if (picked) { applyReference(r, picked, { trusted: true }); r.rerankMatched = true; }
    }));
  // Suspect arbitration: a still-matched compound/coverage suspect asks INDB for
  // the full phrase. Only positive evidence - every content word present in the
  // INDB recipe name - overrides the curated value; otherwise curated stands.
  await Promise.all(rows.map(async (r, i) => {
    const it = items[i];
    // `r.stated` means the user gave us the number themselves. Arbitration runs
    // AFTER resolveItem has already applied it, and applyReference below
    // overwrites macros wholesale — so without this the user's own figure was
    // silently replaced by the database's. That produced the worst failure in
    // the logs: the bot answering "🔄 Corrected:" while showing the unchanged
    // value, so the user had to send "you did not correct it" to be believed.
    // The primary reference path (above) and the gap trail already skip stated
    // rows; this one was the outlier. User-stated macros override everything.
    if (!it || !r.matched_db_id || r.stated || !(it.compound_suspect || it.coverage_suspect)) return;
    const ref = await refLookup(it.food_name);
    if (!ref) return;
    const refName = String(ref.food_name || "").toLowerCase();
    const tokens = contentTokens(it.food_name);
    // Containment alone is too weak — "sabji" is present inside
    // "Okra/Lady's fingers fry (Bhindi sabzi/sabji/subji)". The same acceptance
    // rules as the primary path apply before we override a curated value.
    if (!tokens.length || !tokens.every(w => refName.includes(w))) return;
    if (!acceptableRef(it.food_name, ref.food_name)) return;
    r.matched_db_id = null;
    r.is_estimate = true;
    r.assumed = true;
    applyReference(r, ref, { trusted: true });
  }));
  // Per-user correction memory, applied LAST so it wins over every resolution
  // tier. If this user has told us their oats are 26g protein, that is the
  // answer for them — repeating the question daily is the bug this fixes.
  // applyMemory marks the row `stated`, which is also what stops suspect
  // arbitration from overwriting it further up the pipeline.
  if (opts.phone) {
    const memories = await correctionMemories(opts.phone);
    if (memories.length) {
      const byKey = new Map(memories.map(m => [m.food_key, m]));
      for (const r of rows) {
        if (!r || !r.food_name || r.stated) continue; // a fresh statement outranks the memory
        const mem = byKey.get(memFoodKey(r.food_name));
        if (mem) applyMemory(r, mem);
      }
    }
  }
  // Gap trail: only when actually logging (not query previews). rows[i] maps
  // 1:1 to items[i]. Silent alias rematches are correct outcomes - not logged.
  if (opts.trackGaps) {
    rows.forEach((r, i) => {
      const it = items[i];
      if (!it || !it.food_name || r.stated || r.food_name === "meal") return;
      const reason = it.protein_guard ? "protein_guard"
        : it.compound_suspect ? "compound"
        : it.coverage_suspect ? "coverage"
        : !r.matched_db_id ? "no_match" : null;
      if (!reason) return;
      const source = !r.matched_db_id ? (r.refVerified ? "indb" : "estimate") : "curated_kept";
      logGapEvent({ food: it.food_name, reason, source, served_as: r.food_name, kcal: r.kcal });
    });
  }
  return rows;
}

// Resolve a parsed message into rows ready for user_logs, WITHOUT touching
// user_logs itself. Not pure — resolution reads the reference tier, may call
// the LLM reranker, and writes gap-trail events — but it makes no change to
// anyone's food log, which is the property that lets the atomic replacement
// prepare its payload before opening a transaction.
//
// Shared with logMeal so ordinary logging and correction replacement can never
// resolve nutrition differently. Deliberately additive: logMeal's behaviour is
// unchanged, because the normal path is working and a correction fix has no
// business destabilising it.
async function prepareMealRows(phone, parsed, date) {
  const rows = await resolveRows(parsed, { trackGaps: true, phone });
  const mealTime = parsed.meal_time_inferred || "snack";
  rows.forEach(r => Object.assign(r, { phone_number: phone, meal_time: mealTime, date }));

  // Tier 4: nothing parsed, log a single placeholder rather than a dead end.
  if (rows.length === 0) {
    rows.push({ phone_number: phone, meal_time: mealTime, date, food_name: "meal",
      matched_db_id: null, quantity: 1, unit: "serving", kcal: 300,
      ...splitMacros(300), fiber: 0, is_estimate: true });
  }
  return rows;
}

// Figures the user stated themselves, worth carrying to tomorrow. Returns the
// memory rows rather than writing them: the caller decides WHEN, and for a
// correction that must be only after the transaction has committed. Writing a
// memory for a meal that then failed to save would teach the bot a fact about
// an entry that does not exist.
function pendingMemories(phone, rows) {
  return (rows || [])
    .filter(r => !r.memoryApplied && worthRemembering(r))
    .map(r => toMemoryRow(phone, r));
}

function persistMemories(phone, memRows) {
  for (const m of memRows || []) {
    rememberCorrection(phone, m).catch(e => console.error("rememberCorrection:", e.message));
  }
}

// Atomic correction: delete the targets and insert the replacements inside ONE
// database transaction, or change nothing at all.
//
// Every correction route used to delete and then insert in separate round
// trips. A failure between them left the original food deleted and the
// replacement never written — user …0419 lost a full lunch that way on 1 Aug.
// Awaiting the insert made that failure honest; it did not make it safe.
//
// Throws on any rejection. The caller must treat a throw as "nothing changed",
// which is now literally true.
async function replaceMealAtomic(phone, parsed, targetIds, options = {}) {
  const ids = exactPositiveIds(targetIds);
  if (!ids.length) throw new Error("replaceMealAtomic: no target rows");

  // The user row must exist: user_logs.phone_number is a foreign key to users.
  await ensureUser(phone);

  // Date comes from the RPC, derived from the locked originals — a replacement
  // belongs to the day it replaced, not to today. This date is only used for
  // resolution bookkeeping; the RPC overrides whatever lands in the payload.
  const rows = await prepareMealRows(phone, parsed, options.date || istToday());
  const payload = rows.map(toUserLogInsertRow);

  const { data, error } = await supabase.rpc("replace_user_logs", {
    p_phone: phone,
    p_delete_ids: ids,
    p_rows: payload,
  });
  if (error) {
    console.error("replace_user_logs:", error.message);
    throw new Error(`correction replace failed: ${error.message}`);
  }
  const inserted = Array.isArray(data) ? data : [];
  if (!inserted.length) throw new Error("correction replace returned no rows");

  // Only now is the correction real, so only now is it safe to remember it.
  persistMemories(phone, pendingMemories(phone, rows));

  // Totals re-read AFTER the commit, so the reply reflects what is actually
  // stored rather than what we hoped would be.
  const totals = await todayTotal(phone, inserted[0].date);
  return { rows: inserted, totals };
}

async function logMeal(phone, parsed, options = {}) {
  // Pin the IST date ONCE for this message. todayTotal reads a date, and the
  // insert is fire-and-forget seconds later — near midnight the DB's own
  // `date` default would land on the next day, so the row would vanish from
  // the total we just replied with. Writing it explicitly keeps them agreeing.
  const date = istToday();
  // Previous total fetched in parallel with the user upsert (before the insert,
  // so no double-count); new items are added locally. Saves one DB round-trip.
  const [prevTotal, isNewUser, rows, seqStart] = await Promise.all([
    todayTotal(phone, date), ensureUser(phone), prepareMealRows(phone, parsed, date), nextDaySeq(phone, date),
  ]);

  // Collected now, written only once the insert has actually succeeded. It used
  // to be written here, before the write — so a failed insert left a memory
  // teaching the bot a figure about a meal that was never stored.
  const memories = pendingMemories(phone, rows);

  // Numbers are assigned once, here, and never recomputed — deleting 14 leaves
  // a gap so numbers the user has already seen stay valid. Null seqStart means
  // the column isn't there yet, so items just log without numbers.
  if (seqStart != null) rows.forEach((r, i) => { r.day_seq = seqStart + i; });

  // Fire-and-forget: the reply's totals are computed locally (below), so it need
  // not wait for the write. Saves ~0.7s of India<->Supabase latency per message.
  // ALLOWLIST, not a denylist. This used to strip a hardcoded set of transient
  // fields and pass everything else through, so any new flag added to a row
  // became a column Postgres does not have — and the whole insert failed.
  //
  // It failed silently, which is what made it costly: the reply's totals are
  // computed locally, so the user was told "✅ Logged … you're at 1355 kcal"
  // while nothing was written. `rerankMatched` (added 22 Jul) destroyed 18
  // meals across 17 users before anyone noticed, and `memoryApplied` (added
  // today) began doing the same within hours. Both were introduced by changes
  // that had nothing to do with persistence and passed every test.
  //
  // With an allowlist a stray flag is simply dropped, and the failure mode of
  // forgetting to update this list is a missing value rather than a lost meal.
  const insert = supabase.from("user_logs")
    .insert(rows.map(toUserLogInsertRow));
  if (options.awaitInsert) {
    const { error } = await insert;
    if (error) {
      console.error("SUPABASE INSERT FAILED:", error.message, error.details || "", error.hint || "");
      throw new Error("meal insert failed");
    }
    persistMemories(phone, memories);
  } else {
    insert.then(({ error }) => {
      if (error) console.error("SUPABASE INSERT FAILED:", error.message, error.details || "", error.hint || "");
      else persistMemories(phone, memories);
    });
  }
  const sum = (k) => prevTotal[k] + rows.reduce((s, r) => s + Number(r[k] || 0), 0);

  // Slot this message into the meal clusters: continues the last meal if within 45 min.
  const meals = prevTotal.meals;
  const newKcal = rows.reduce((s, r) => s + Number(r.kcal || 0), 0);
  const newProtein = rows.reduce((s, r) => s + Number(r.protein || 0), 0);
  const now = Date.now();
  const last = meals[meals.length - 1];
  if (last && now - last.lastAt <= MEAL_GAP_MS) { last.kcal += newKcal; last.protein += newProtein; }
  else meals.push({ kcal: newKcal, protein: newProtein, lastAt: now });

  return {
    rows,
    meals: meals.map(m => ({ kcal: Math.round(m.kcal), protein: Math.round(m.protein || 0) })),
    totals: { kcal: sum("kcal"), protein: sum("protein"), carbs: sum("carbs"), fat: sum("fat"), fiber: sum("fiber") },
    isNewUser,
  };
}

async function todayTotal(phone, pinnedDate) {
  const today = pinnedDate || istToday();
  const { data, error } = await supabase.from("user_logs")
    .select("kcal, protein, carbs, fat, fiber, logged_at").eq("phone_number", phone).eq("date", today)
    .order("logged_at", { ascending: true });
  if (error) console.error("SUPABASE SELECT FAILED:", error.message);
  console.log(`todayTotal: phone=${maskPhone(phone)} date=${today} rows=${(data||[]).length}`);
  const totals = (data || []).reduce(
    (s, r) => ({
      kcal: s.kcal + Number(r.kcal || 0), protein: s.protein + Number(r.protein || 0),
      carbs: s.carbs + Number(r.carbs || 0), fat: s.fat + Number(r.fat || 0), fiber: s.fiber + Number(r.fiber || 0),
    }),
    { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 }
  );
  // Cluster today's rows into meals: a gap > 45 min starts a new meal (PRD session window).
  const meals = [];
  for (const r of data || []) {
    const at = new Date(r.logged_at).getTime();
    const last = meals[meals.length - 1];
    if (last && at - last.lastAt <= MEAL_GAP_MS) {
      last.kcal += Number(r.kcal || 0);
      last.protein += Number(r.protein || 0);
      last.lastAt = at;
    } else {
      meals.push({ kcal: Number(r.kcal || 0), protein: Number(r.protein || 0), lastAt: at });
    }
  }
  return { ...totals, meals };
}

// Itemized day report: meals (45-min clusters) with their items + macro totals.
async function dayReport(phone, daysAgo = 0) {
  const date = new Date(Date.now() - daysAgo * 86400000)
    .toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const { data, error } = await supabase.from("user_logs")
    .select("food_name, quantity, kcal, protein, carbs, fat, fiber, logged_at, day_seq")
    .eq("phone_number", phone).eq("date", date).order("logged_at", { ascending: true });
  if (error) console.error("dayReport:", error.message);
  const meals = [];
  const totals = { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 };
  for (const r of data || []) {
    for (const k of Object.keys(totals)) totals[k] += Number(r[k] || 0);
    const at = new Date(r.logged_at).getTime();
    const last = meals[meals.length - 1];
    const base = Number(r.quantity) === 1 ? r.food_name : `${r.food_name} \u00d7${Number(r.quantity)}`;
    const item = r.day_seq != null ? `${r.day_seq}. ${base}` : base;
    if (last && at - last.lastAt <= MEAL_GAP_MS) {
      last.kcal += Number(r.kcal || 0); last.protein += Number(r.protein || 0);
      last.items.push(item); last.lastAt = at;
    } else {
      meals.push({ kcal: Number(r.kcal || 0), protein: Number(r.protein || 0), items: [item], lastAt: at });
    }
  }
  const label = new Date(Date.now() - daysAgo * 86400000)
    .toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
  return { label, meals, totals };
}

// The immediately preceding inbound log. This is intentionally narrower than a
// 45-minute meal: implicit corrections may only affect this one message batch.
async function lastLogBatch(phone) {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const { data, error } = await supabase.from("user_logs")
    .select("id, food_name, kcal, protein, quantity, matched_db_id, is_estimate, logged_at, date")
    .eq("phone_number", phone).eq("date", today)
    .order("logged_at", { ascending: false })
    .limit(30);
  if (error) console.error("lastLogBatch select:", error.message);
  if (!data || data.length === 0) return [];
  const lastTs = data[0].logged_at;
  return data.filter(r => r.logged_at === lastTs);
}

const exactPositiveIds = ids => {
  if (!Array.isArray(ids) || !ids.length || ids.length > 20) return [];
  if (!ids.every(id => Number.isInteger(id) && id > 0)) return [];
  const unique = [...new Set(ids)];
  return unique.length === ids.length ? unique : [];
};

async function logRowsByExactIds(phone, ids, client = supabase) {
  const expected = exactPositiveIds(ids);
  if (typeof phone !== "string" || !phone || !expected.length) return [];
  const { data, error } = await client.from("user_logs")
    .select("id, food_name, kcal, protein, quantity, matched_db_id, is_estimate, logged_at, date")
    .eq("phone_number", phone)
    .in("id", expected);
  if (error) {
    console.error("logRowsByExactIds:", error.message);
    return [];
  }
  const rows = Array.isArray(data) ? data : [];
  const byId = new Map(rows.map(row => [Number(row.id), row]));
  if (rows.length !== expected.length || expected.some(id => !byId.has(id))) return [];
  return expected.map(id => byId.get(id));
}

async function deleteLogRowsByExactIds(phone, ids, client = supabase) {
  const expected = exactPositiveIds(ids);
  if (!expected.length) return null;
  const existing = await logRowsByExactIds(phone, expected, client);
  if (existing.length !== expected.length) return null;
  const { data, error } = await client.rpc(
    "delete_user_logs_exact",
    { p_phone: phone, p_ids: expected }
  );
  if (error) {
    console.error("deleteLogRowsByExactIds:", error.message);
    return null;
  }
  const deleted = Array.isArray(data) ? data : [];
  const deletedIds = new Set(deleted.map(row => Number(row.id)));
  if (deleted.length !== expected.length || expected.some(id => !deletedIds.has(id))) return null;
  const byId = new Map(deleted.map(row => [Number(row.id), row]));
  return expected.map(id => byId.get(id));
}

async function deleteRows(rows) {
  if (!rows || rows.length === 0) return;
  const { error } = await supabase.from("user_logs").delete().in("id", rows.map(r => r.id));
  if (error) console.error("delete rows:", error.message);
}

// Named correction targets must be in the immediately preceding message batch.
// This intentionally does not scan the whole day: an implicit correction should
// never surprise-delete a food from an earlier meal.
// Find-only counterpart of deleteMatchingLastLog: all the matching, none of
// the deleting. Atomic replacement needs the targets identified before the
// transaction opens, so the delete can happen alongside the insert rather than
// before it. deleteMatchingLastLog now wraps this, so both paths resolve
// targets by exactly the same rules.
async function matchLastLogTargets(phone, foodHints, batch = null, rawMessage = "") {
  const latest = batch && batch.length ? batch : await lastLogBatch(phone);
  const matched = matchRows(latest, foodHints, rawMessage);
  // Deterministic word-overlap can't place a hint whose logged name shares no
  // words ("the whey" vs a row named "SuperYou PRO"). Before giving up, let the
  // LLM pick the target by meaning - over rows not already claimed. Preserves
  // atomicity: a still-unresolved hint below still aborts the whole correction.
  const hints = (foodHints || []);
  for (let i = 0; i < matched.length; i++) {
    if (matched[i]) continue;
    const claimed = new Set(matched.filter(Boolean).map(r => r.id));
    const pool = latest.filter(r => !claimed.has(r.id));
    if (!pool.length) break;
    const h = hints[i];
    const query = (h && typeof h === "object" ? h.food_name : h) || rawMessage;
    const picked = await rerankTarget(query, pool);
    if (picked) matched[i] = picked;
  }
  // Multi-item corrections are atomic: if one stated item cannot be found in
  // the most recent batch, leave everything untouched rather than half-editing
  // a meal and creating a worse trust failure.
  if (matched.some(row => !row)) return null;
  if (matched.filter(Boolean).length === 0) return null;
  return matched;
}

async function deleteMatchingLastLog(phone, foodHints, batch = null, rawMessage = "") {
  // Kept for the undo path, which genuinely only deletes. Correction routes use
  // matchLastLogTargets + replaceMealAtomic so the delete lands inside the same
  // transaction as the replacement.
  const matched = await matchLastLogTargets(phone, foodHints, batch, rawMessage);
  if (!matched) return null;
  await deleteRows(matched.filter(Boolean));
  return matched;
}

// Correction targeting: find and delete today's row that best name-matches each
// corrected food — searches the whole day, not just the last message's batch,
// so "roti was 60 cal and dal 120" replaces the right rows wherever they were
// logged. Returns the deleted rows, or null if nothing matched.
async function deleteMatching(phone, foodHints) {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const { data, error } = await supabase.from("user_logs")
    .select("id, food_name, kcal, protein, quantity, matched_db_id, logged_at")
    .eq("phone_number", phone).eq("date", today)
    .order("logged_at", { ascending: false })
    .limit(30);
  if (error) console.error("deleteMatching select:", error.message);
  if (!data || data.length === 0) return null;

  const taken = new Set();
  const matched = [];
  for (const hint of foodHints) {
    const words = String(hint || "").toLowerCase().split(/[^a-z]+/).filter(w => w.length > 2);
    let best = null, bestScore = 0;
    for (const row of data) {
      if (taken.has(row.id)) continue;
      const name = row.food_name.toLowerCase();
      const score = words.filter(w => name.includes(w)).length;
      if (score > bestScore) { best = row; bestScore = score; }
    }
    taken.add(best ? best.id : -1); matched.push(best || null);
  }
  const rows = matched.filter(Boolean);
  if (rows.length === 0) return null;
  const { error: delErr } = await supabase.from("user_logs").delete().in("id", rows.map(r => r.id));
  if (delErr) console.error("deleteMatching delete:", delErr.message);
  return matched; // aligned with foodHints; null entries = no match for that hint
}

const istToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

// Next per-day item number. Returns null when the day_seq column doesn't exist
// yet (item-numbers.sql not run), which switches the whole feature off rather
// than breaking logging.
async function nextDaySeq(phone, pinnedDate) {
  const { data, error } = await supabase.from("user_logs")
    .select("day_seq").eq("phone_number", phone).eq("date", pinnedDate || istToday())
    .order("day_seq", { ascending: false, nullsFirst: false }).limit(1);
  if (error) return null;
  return (Number(data && data[0] && data[0].day_seq) || 0) + 1;
}

// Today's live item numbers, for validating a user's reference before acting.
async function todaySeqs(phone) {
  const { data, error } = await supabase.from("user_logs")
    .select("day_seq").eq("phone_number", phone).eq("date", istToday())
    .not("day_seq", "is", null).order("day_seq");
  if (error) return [];
  return (data || []).map(r => Number(r.day_seq));
}

// Delete by explicit item number ("undo 14"). Day-scoped, so a stale number
// from yesterday can never hit an unrelated row.
// All of today's logged rows (number + name + kcal), oldest first. Lets a
// name-based "replace X with…" find X anywhere in the day, not just the last
// batch, and delete it by its stable number.
async function todayItems(phone) {
  const { data, error } = await supabase.from("user_logs")
    .select("food_name, kcal, matched_db_id, day_seq")
    .eq("phone_number", phone).eq("date", istToday())
    .not("day_seq", "is", null).order("day_seq");
  if (error) return [];
  return data || [];
}

// Read-only lookup of today's rows by item number — lets the bot echo
// "item 2 is X" instead of handing a bare "item 2" to the LLM (which once
// hallucinated "Paratha x2" from it).
async function itemsBySeq(phone, seqs) {
  const { data, error } = await supabase.from("user_logs")
    .select("food_name, kcal, day_seq")
    .eq("phone_number", phone).eq("date", istToday()).in("day_seq", seqs)
    .order("day_seq");
  if (error) return [];
  return data || [];
}

// Find-only counterpart of deleteBySeq. Atomic replacement needs the target
// ids WITHOUT removing them first — the whole point is that the delete happens
// inside the same transaction as the insert.
async function rowsBySeq(phone, seqs) {
  const { data, error } = await supabase.from("user_logs")
    .select("id, food_name, kcal, quantity, day_seq")
    .eq("phone_number", phone).eq("date", istToday()).in("day_seq", seqs)
    .order("day_seq");
  if (error) { console.error("rowsBySeq:", error.message); return []; }
  return data || [];
}

async function deleteBySeq(phone, seqs) {
  const { data, error } = await supabase.from("user_logs").delete()
    .eq("phone_number", phone).eq("date", istToday()).in("day_seq", seqs)
    .select("food_name, kcal, day_seq");
  if (error) { console.error("deleteBySeq:", error.message); return null; }
  return data || [];
}

// "Delete all entries": clear the whole IST day. The PRD's narrow undo stays
// the default — this only fires when the user says an explicit all-scope word.
async function deleteAllToday(phone) {
  const date = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const { data, error } = await supabase.from("user_logs").delete()
    .eq("phone_number", phone).eq("date", date).select("food_name, kcal");
  if (error) { console.error("deleteAllToday:", error.message); return null; }
  return data || [];
}

// Find-only counterpart of deleteLastLog: same name-overlap narrowing, no
// delete. Used by the correction routes so the removal happens inside the
// replacement transaction.
async function lastLogTargets(phone, foodHint) {
  let batch = await lastLogBatch(phone);
  if (batch.length === 0) return null;
  if (foodHint && batch.length > 1) {
    const words = String(foodHint).toLowerCase().split(/[^a-z]+/).filter(w => w.length > 2);
    const scored = batch.map(r => ({ r, s: words.filter(w => r.food_name.toLowerCase().includes(w)).length }));
    const best = Math.max(...scored.map(x => x.s));
    if (best > 0) batch = scored.filter(x => x.s === best).map(x => x.r);
  }
  return batch;
}

async function deleteLastLog(phone, foodHint) {
  let batch = await lastLogBatch(phone);
  if (batch.length === 0) return null;
  // Correction targeting one item inside a multi-item log ("fish sticks were
  // 230 cal" after logging fish + milk + rice together): delete only the rows
  // whose name overlaps the corrected food, not the whole batch.
  if (foodHint && batch.length > 1) {
    const words = String(foodHint).toLowerCase().split(/[^a-z]+/).filter(w => w.length > 2);
    const scored = batch.map(r => ({ r, s: words.filter(w => r.food_name.toLowerCase().includes(w)).length }));
    const best = Math.max(...scored.map(x => x.s));
    if (best > 0) batch = scored.filter(x => x.s === best).map(x => x.r);
  }
  await deleteRows(batch);
  return batch;
}

// --- Per-user correction memory --------------------------------------------
// Missing table is not an error: the feature stays dormant until
// correction-memory.sql is applied, and logging must never break because an
// optional memory lookup failed.
let memoryTableMissing = false;
const isMissingMemoryTable = e =>
  !!e && /correction_memory/i.test(String(e.message || "")) && /does not exist|schema cache/i.test(String(e.message || ""));

async function correctionMemories(phone) {
  if (memoryTableMissing || !phone) return [];
  const { data, error } = await supabase.from("correction_memory")
    .select("food_key, food_name, protein_per_unit, kcal_per_unit, unit")
    .eq("phone_number", phone);
  if (error) {
    if (isMissingMemoryTable(error)) { memoryTableMissing = true; return []; }
    console.error("correctionMemories:", error.message);
    return [];
  }
  return data || [];
}

async function rememberCorrection(phone, memRow) {
  if (memoryTableMissing || !phone || !memRow || !memRow.food_key) return false;
  const { error } = await supabase.from("correction_memory")
    .upsert({ ...memRow, updated_at: new Date().toISOString() }, { onConflict: "phone_number,food_key" });
  if (error) {
    if (isMissingMemoryTable(error)) { memoryTableMissing = true; return false; }
    console.error("rememberCorrection:", error.message);
    return false;
  }
  return true;
}

async function forgetCorrection(phone, foodKey) {
  if (memoryTableMissing || !phone || !foodKey) return false;
  const { data, error } = await supabase.from("correction_memory")
    .delete().eq("phone_number", phone).eq("food_key", foodKey).select("food_name");
  if (error) {
    if (isMissingMemoryTable(error)) { memoryTableMissing = true; return false; }
    console.error("forgetCorrection:", error.message);
    return false;
  }
  return !!(data && data.length);
}

// --- Daily summary (opt-in reminder) ---------------------------------------

// Everyone opted in. The list is small (opt-in only) so the scheduler filters
// for who is actually due in code, where isDue can be unit-tested.
async function summarySubscribers() {
  const { data, error } = await supabase.from("users")
    .select("phone_number, name, goal_kcal, goal_protein, daily_summary_time, daily_summary_last_sent")
    .not("daily_summary_time", "is", null);
  if (error) {
    // Surfaced rather than swallowed: without daily_summary_last_sent there is
    // no way to guarantee one send per day, and the scheduler must not run.
    return { error: error.message, rows: [] };
  }
  return { error: null, rows: data || [] };
}

async function setSummaryTime(phone, time) {
  const { error } = await supabase.from("users")
    .upsert({ phone_number: phone, daily_summary_time: time }, { onConflict: "phone_number" });
  if (error) { console.error("setSummaryTime:", error.message); return false; }
  return true;
}

// Claim the send for today BEFORE dispatching. If the message then fails the
// user simply misses one day — far better than a retry loop messaging them
// repeatedly, which for an opt-in nudge is the unforgivable failure.
async function claimSummarySend(phone, istDate) {
  const { data, error } = await supabase.from("users")
    .update({ daily_summary_last_sent: istDate })
    .eq("phone_number", phone)
    // `neq` alone is wrong here: a fresh subscriber has last_sent = NULL, and
    // in SQL `NULL <> '2026-07-31'` is NULL rather than TRUE, so the row is
    // filtered out and the claim never succeeds. That silently meant nobody
    // could ever receive a first summary. The null branch is required.
    .or(`daily_summary_last_sent.is.null,daily_summary_last_sent.neq.${istDate}`)
    .select("phone_number");
  if (error) { console.error("claimSummarySend:", error.message); return false; }
  return !!(data && data.length);
}

// Timestamp of the user's last inbound message — decides whether WhatsApp's
// 24h free-form window is still open.
async function lastInboundAt(phone) {
  const { data, error } = await supabase.from("message_log")
    .select("at").eq("phone_number", phone)
    .order("at", { ascending: false }).limit(1);
  if (error) { console.error("lastInboundAt:", error.message); return null; }
  return data && data[0] ? data[0].at : null;
}

module.exports = { supabase, acceptableRef, refCandidates, refRerank, logMeal, deleteBySeq, itemsBySeq, todayItems, todaySeqs, todayTotal, deleteLastLog, deleteAllToday, deleteMatching, deleteMatchingLastLog, lastLogBatch, logRowsByExactIds, deleteLogRowsByExactIds, ensureUser, getProfile, saveProfile, saveTdeeProfile, saveConversationState, claimConversationState, clearConversationStateIfUnchanged, recentConversation, bumpNudge, resolveRows, toUserLogInsertRow, prepareMealRows, replaceMealAtomic, rowsBySeq, matchLastLogTargets, lastLogTargets, dayReport, correctionMemories, rememberCorrection, forgetCorrection, summarySubscribers, setSummaryTime, claimSummarySend, lastInboundAt };
