// Supabase helpers: ensure user, log items, compute today's total.
const { createClient } = require("@supabase/supabase-js");
const { FOOD_BY_ID } = require("./foods.js");
const { matchRows } = require("./correctionContext.js");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const MEAL_GAP_MS = 45 * 60 * 1000; // PRD: messages within 45 min = same meal

// Upserts the user; returns true when the phone number is brand-new (first
// contact ever) so the caller can show a one-time welcome.
async function ensureUser(phone) {
  const { data, error } = await supabase.from("users")
    .upsert({ phone_number: phone }, { onConflict: "phone_number", ignoreDuplicates: true })
    .select("phone_number");
  if (error) { console.error("SUPABASE UPSERT USER FAILED:", error.message); return false; }
  return (data || []).length > 0;
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
const splitMacros = (kcal) => ({
  protein: +(kcal * 0.25 / 4).toFixed(1),
  carbs: +(kcal * 0.5 / 4).toFixed(1),
  fat: +(kcal * 0.25 / 9).toFixed(1),
});

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
  const grams = Number(item.grams);

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
        : { ...splitMacros(statedKcal * qs), fiber: 0 }),
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
  if (PORTION_UNITS.has(food ? food.unit : "serving") && qty > 5) qty = 5;
  if (food && qty === 0) qty = 0.5; // a matched food must log something, never 0

  if (food) {
    // Tier 1/2: direct or category DB match
    const m = qty * rw;
    return {
      food_name: `${dName}${rawTag}`, matched_db_id: food.id, quantity: qty, unit: food.unit,
      kcal: Math.round(food.kcal * m), protein: +(food.p * m).toFixed(1),
      carbs: +(food.c * m).toFixed(1), fat: +(food.f * m).toFixed(1),
      fiber: +((food.fb || 0) * m).toFixed(1),
      is_estimate: item.match_type !== "direct" || item.portion_clarity !== "specified",
      userSaid: item.food_name, assumed: item.match_type !== "direct",
      portionNote: item.portion_clarity !== "specified" ? `${qty} ${food.unit}` : null,
    };
  }
  // Tier 3: unknown food but the LLM knows it — use its per-serving estimate,
  // clamped so a hallucinated number can't poison a day. Tier 4: flat 300 floor.
  const est = Number(item.est_kcal);
  const perServing = Number.isFinite(est) && est > 0 ? Math.min(Math.max(Math.round(est), 20), 800) : 300;
  // Weight-based even for uncurated foods: scale the estimate by grams / ~150g serving.
  if (grams > 0 && grams <= 2000) {
    const s = grams / 150;
    return {
      food_name: `${grams}g ${item.food_name || "meal"}`, matched_db_id: null, quantity: 1,
      unit: `${grams}g`, kcal: Math.round(perServing * s), ...splitMacros(perServing * s), fiber: 0,
      is_estimate: true, userSaid: item.food_name, assumed: true,
    };
  }
  return {
    food_name: item.food_name || "meal", matched_db_id: null, quantity: qty, unit: "serving",
    kcal: Math.round(perServing * qty), ...splitMacros(perServing * qty), fiber: 0, is_estimate: true,
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

// Some INDB serving values are whole-recipe yields, not one portion — trust the
// serving numbers only in a plausible range, else derive from per-100g (~150g serving).
function applyReference(row, ref) {
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
  const llmPerServing = row.kcal / qty;
  if (llmPerServing > 0 && (perServing > llmPerServing * 2 || perServing < llmPerServing * 0.5)) return;

  row.kcal = Math.round(perServing * qty);
  row.protein = +(p * qty).toFixed(1);
  row.carbs = +(c * qty).toFixed(1);
  row.fat = +(f * qty).toFixed(1);
  row.fiber = +(fb * qty).toFixed(1);
  row.unit = unit;
  row.food_name = ref.food_name;
}

// Resolve parsed items to nutrition rows (curated -> INDB -> estimate) without
// touching the log — shared by logMeal and query-intent previews.
async function resolveRows(parsed) {
  const rows = (parsed.items || []).map(it => resolveItem(it));
  // Cross-reference unmatched foods against INDB (parallel, misses only).
  await Promise.all(rows
    .filter(r => !r.matched_db_id && !r.stated && r.food_name && r.food_name !== "meal")
    .map(async r => {
      const ref = await refLookup(r.food_name);
      if (ref) applyReference(r, ref);
    }));
  return rows;
}

async function logMeal(phone, parsed) {
  // Previous total fetched in parallel with the user upsert (before the insert,
  // so no double-count); new items are added locally. Saves one DB round-trip.
  const [prevTotal, isNewUser, rows] = await Promise.all([todayTotal(phone), ensureUser(phone), resolveRows(parsed)]);
  const mealTime = parsed.meal_time_inferred || "snack";
  rows.forEach(r => Object.assign(r, { phone_number: phone, meal_time: mealTime }));

  // If nothing parsed, log a single 300 kcal placeholder (Tier 4).
  if (rows.length === 0) {
    rows.push({ phone_number: phone, meal_time: mealTime, food_name: "meal",
      matched_db_id: null, quantity: 1, unit: "serving", kcal: 300,
      ...splitMacros(300), fiber: 0, is_estimate: true });
  }

  // Fire-and-forget: the reply's totals are computed locally (below), so it need
  // not wait for the write. Saves ~0.7s of India<->Supabase latency per message.
  supabase.from("user_logs").insert(rows.map(({ stated, userSaid, assumed, portionNote, ...r }) => r)).then(({ error }) => {
    if (error) console.error("SUPABASE INSERT FAILED:", error.message, error.details || "", error.hint || "");
  });
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

async function todayTotal(phone) {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const { data, error } = await supabase.from("user_logs")
    .select("kcal, protein, carbs, fat, fiber, logged_at").eq("phone_number", phone).eq("date", today)
    .order("logged_at", { ascending: true });
  if (error) console.error("SUPABASE SELECT FAILED:", error.message);
  console.log(`todayTotal: phone=${phone} date=${today} rows=${(data||[]).length}`);
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
    .select("food_name, quantity, kcal, protein, carbs, fat, fiber, logged_at")
    .eq("phone_number", phone).eq("date", date).order("logged_at", { ascending: true });
  if (error) console.error("dayReport:", error.message);
  const meals = [];
  const totals = { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 };
  for (const r of data || []) {
    for (const k of Object.keys(totals)) totals[k] += Number(r[k] || 0);
    const at = new Date(r.logged_at).getTime();
    const last = meals[meals.length - 1];
    const item = Number(r.quantity) === 1 ? r.food_name : `${r.food_name} \u00d7${Number(r.quantity)}`;
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
    .select("id, food_name, kcal, protein, quantity, matched_db_id, is_estimate, logged_at")
    .eq("phone_number", phone).eq("date", today)
    .order("logged_at", { ascending: false })
    .limit(30);
  if (error) console.error("lastLogBatch select:", error.message);
  if (!data || data.length === 0) return [];
  const lastTs = data[0].logged_at;
  return data.filter(r => r.logged_at === lastTs);
}

async function deleteRows(rows) {
  if (!rows || rows.length === 0) return;
  const { error } = await supabase.from("user_logs").delete().in("id", rows.map(r => r.id));
  if (error) console.error("delete rows:", error.message);
}

// Named correction targets must be in the immediately preceding message batch.
// This intentionally does not scan the whole day: an implicit correction should
// never surprise-delete a food from an earlier meal.
async function deleteMatchingLastLog(phone, foodHints, batch = null, rawMessage = "") {
  // [] is truthy in JavaScript. Treat an empty context as absent so a
  // correction that was not pre-classified still looks up the latest batch.
  const latest = batch && batch.length ? batch : await lastLogBatch(phone);
  const matched = matchRows(latest, foodHints, rawMessage);
  // Multi-item corrections are atomic: if one stated item cannot be found in
  // the most recent batch, leave everything untouched rather than half-editing
  // a meal and creating a worse trust failure.
  if (matched.some(row => !row)) return null;
  const rows = matched.filter(Boolean);
  if (rows.length === 0) return null;
  await deleteRows(rows);
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

module.exports = { logMeal, todayTotal, deleteLastLog, deleteMatching, deleteMatchingLastLog, lastLogBatch, ensureUser, resolveRows, dayReport };
