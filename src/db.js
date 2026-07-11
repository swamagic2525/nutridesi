// Supabase helpers: ensure user, log items, compute today's total.
const { createClient } = require("@supabase/supabase-js");
const { FOOD_BY_ID } = require("./foods.js");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const MEAL_GAP_MS = 45 * 60 * 1000; // PRD: messages within 45 min = same meal

async function ensureUser(phone) {
  const { error } = await supabase.from("users").upsert({ phone_number: phone }, { onConflict: "phone_number" });
  if (error) console.error("SUPABASE UPSERT USER FAILED:", error.message);
}

// Approximate grams in one serving of each unit — used to convert weight-based
// logging ("100g X") into calories when a food has no explicit `g` field.
const UNIT_GRAMS = {
  bowl: 150, katori: 120, cup: 150, plate: 200, glass: 200, serving: 150,
  medium: 150, slice: 30, scoop: 30, tbsp: 15, tsp: 5, handful: 30,
  fillet: 100, bar: 50, pack: 70, "100g": 100, white: 33,
};

// Convert a parsed item into a log row with resolved nutrition + 4-tier fallback.
function resolveItem(item) {
  const food = item.matched_db_id ? FOOD_BY_ID[item.matched_db_id] : null;
  const grams = Number(item.grams);

  // Weight-based logging: scale nutrition by exact grams / serving-grams. This is
  // what makes "40g rice", "100g soya chunks", "200g chicken" accurate.
  if (food && grams > 0 && grams <= 2000) {
    const servingG = food.g || UNIT_GRAMS[food.unit] || 150;
    const s = grams / servingG;
    return {
      food_name: `${grams}g ${food.name}`, matched_db_id: food.id, quantity: 1, unit: `${grams}g`,
      kcal: Math.round(food.kcal * s), protein: +(food.p * s).toFixed(1),
      carbs: +(food.c * s).toFixed(1), fat: +(food.f * s).toFixed(1),
      fiber: +((food.fb || 0) * s).toFixed(1), is_estimate: true,
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
    return {
      food_name: food.name, matched_db_id: food.id, quantity: qty, unit: food.unit,
      kcal: Math.round(food.kcal * qty), protein: +(food.p * qty).toFixed(1),
      carbs: +(food.c * qty).toFixed(1), fat: +(food.f * qty).toFixed(1),
      fiber: +((food.fb || 0) * qty).toFixed(1),
      is_estimate: item.match_type !== "direct" || item.portion_clarity !== "specified",
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
      unit: `${grams}g`, kcal: Math.round(perServing * s), protein: 0, carbs: 0, fat: 0, fiber: 0, is_estimate: true,
    };
  }
  return {
    food_name: item.food_name || "meal", matched_db_id: null, quantity: qty, unit: "serving",
    kcal: Math.round(perServing * qty), protein: 0, carbs: 0, fat: 0, fiber: 0, is_estimate: true,
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

async function logMeal(phone, parsed) {
  // Previous total fetched in parallel with the user upsert (before the insert,
  // so no double-count); new items are added locally. Saves one DB round-trip.
  const [prevTotal] = await Promise.all([todayTotal(phone), ensureUser(phone)]);
  const mealTime = parsed.meal_time_inferred || "snack";
  const rows = (parsed.items || []).map(it => {
    const r = resolveItem(it);
    return { phone_number: phone, meal_time: mealTime, ...r };
  });

  // Cross-reference unmatched foods against INDB (parallel, misses only).
  await Promise.all(rows
    .filter(r => !r.matched_db_id && r.food_name && r.food_name !== "meal")
    .map(async r => {
      const ref = await refLookup(r.food_name);
      if (ref) applyReference(r, ref);
    }));

  // If nothing parsed, log a single 300 kcal placeholder (Tier 4).
  if (rows.length === 0) {
    rows.push({ phone_number: phone, meal_time: mealTime, food_name: "meal",
      matched_db_id: null, quantity: 1, unit: "serving", kcal: 300,
      protein: 0, carbs: 0, fat: 0, fiber: 0, is_estimate: true });
  }

  const { error } = await supabase.from("user_logs").insert(rows);
  if (error) console.error("SUPABASE INSERT FAILED:", error.message, error.details || "", error.hint || "");
  const sum = (k) => prevTotal[k] + rows.reduce((s, r) => s + Number(r[k] || 0), 0);

  // Slot this message into the meal clusters: continues the last meal if within 45 min.
  const meals = prevTotal.meals;
  const newKcal = rows.reduce((s, r) => s + Number(r.kcal || 0), 0);
  const now = Date.now();
  const last = meals[meals.length - 1];
  if (last && now - last.lastAt <= MEAL_GAP_MS) last.kcal += newKcal;
  else meals.push({ kcal: newKcal, lastAt: now });

  return {
    rows,
    meals: meals.map(m => Math.round(m.kcal)),
    totals: { kcal: sum("kcal"), protein: sum("protein"), carbs: sum("carbs"), fat: sum("fat"), fiber: sum("fiber") },
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
      last.lastAt = at;
    } else {
      meals.push({ kcal: Number(r.kcal || 0), lastAt: at });
    }
  }
  return { ...totals, meals };
}

async function deleteLastLog(phone) {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const { data, error: selErr } = await supabase.from("user_logs")
    .select("id, food_name, kcal, quantity, logged_at")
    .eq("phone_number", phone).eq("date", today)
    .order("logged_at", { ascending: false })
    .limit(20);
  if (selErr) console.error("deleteLastLog select:", selErr.message);
  if (!data || data.length === 0) return null;

  const lastTs = data[0].logged_at;
  const batch = data.filter(r => r.logged_at === lastTs);
  const ids = batch.map(r => r.id);

  const { error: delErr } = await supabase.from("user_logs").delete().in("id", ids);
  if (delErr) console.error("deleteLastLog delete:", delErr.message);

  return batch;
}

module.exports = { logMeal, todayTotal, deleteLastLog };
