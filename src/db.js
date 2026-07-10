// Supabase helpers: ensure user, log items, compute today's total.
const { createClient } = require("@supabase/supabase-js");
const { FOOD_BY_ID } = require("./foods.js");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const MEAL_GAP_MS = 45 * 60 * 1000; // PRD: messages within 45 min = same meal

async function ensureUser(phone) {
  const { error } = await supabase.from("users").upsert({ phone_number: phone }, { onConflict: "phone_number" });
  if (error) console.error("SUPABASE UPSERT USER FAILED:", error.message);
}

// Convert a parsed item into a log row with resolved nutrition + 4-tier fallback.
function resolveItem(item) {
  // Accept any positive quantity (7 eggs, 4 roti), snapped to 0.5 steps and capped.
  const q = Number(item.quantity);
  const qty = Number.isFinite(q) && q > 0 ? Math.min(Math.round(q * 2) / 2, 30) : 1.0;
  const food = item.matched_db_id ? FOOD_BY_ID[item.matched_db_id] : null;

  if (food) {
    // Tier 1/2: direct or category DB match
    return {
      food_name: food.name, matched_db_id: food.id, quantity: qty, unit: food.unit,
      kcal: Math.round(food.kcal * qty), protein: +(food.p * qty).toFixed(1),
      carbs: +(food.c * qty).toFixed(1), fat: +(food.f * qty).toFixed(1),
      is_estimate: item.match_type !== "direct" || item.portion_clarity !== "specified",
    };
  }
  // Tier 3: unknown food but the LLM knows it — use its per-serving estimate,
  // clamped so a hallucinated number can't poison a day. Tier 4: flat 300 floor.
  const est = Number(item.est_kcal);
  const perServing = Number.isFinite(est) && est > 0 ? Math.min(Math.max(Math.round(est), 20), 800) : 300;
  return {
    food_name: item.food_name || "meal", matched_db_id: null, quantity: qty, unit: "serving",
    kcal: Math.round(perServing * qty), protein: 0, carbs: 0, fat: 0, is_estimate: true,
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
  if (inRange(Number(ref.serving_kcal))) {
    row.kcal = Math.round(ref.serving_kcal * qty);
    row.protein = +(Number(ref.serving_protein || 0) * qty).toFixed(1);
    row.carbs = +(Number(ref.serving_carbs || 0) * qty).toFixed(1);
    row.fat = +(Number(ref.serving_fat || 0) * qty).toFixed(1);
    row.unit = ref.serving_unit || "serving";
  } else if (Number(ref.kcal_100g) > 0) {
    const scale = 1.5 * qty; // assume ~150g serving
    row.kcal = Math.min(Math.max(Math.round(ref.kcal_100g * scale), 20), 800 * qty);
    row.protein = +(Number(ref.protein_100g || 0) * scale).toFixed(1);
    row.carbs = +(Number(ref.carbs_100g || 0) * scale).toFixed(1);
    row.fat = +(Number(ref.fat_100g || 0) * scale).toFixed(1);
  } else {
    return; // no usable numbers — keep the LLM estimate
  }
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
      protein: 0, carbs: 0, fat: 0, is_estimate: true });
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
    totals: { kcal: sum("kcal"), protein: sum("protein"), carbs: sum("carbs"), fat: sum("fat") },
  };
}

async function todayTotal(phone) {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const { data, error } = await supabase.from("user_logs")
    .select("kcal, protein, carbs, fat, logged_at").eq("phone_number", phone).eq("date", today)
    .order("logged_at", { ascending: true });
  if (error) console.error("SUPABASE SELECT FAILED:", error.message);
  console.log(`todayTotal: phone=${phone} date=${today} rows=${(data||[]).length}`);
  const totals = (data || []).reduce(
    (s, r) => ({
      kcal: s.kcal + Number(r.kcal || 0), protein: s.protein + Number(r.protein || 0),
      carbs: s.carbs + Number(r.carbs || 0), fat: s.fat + Number(r.fat || 0),
    }),
    { kcal: 0, protein: 0, carbs: 0, fat: 0 }
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
