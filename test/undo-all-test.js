require("dotenv").config();
const assert = require("assert");
const { supabase, deleteAllToday } = require("../src/db.js");

const PHONE = "+0000000098"; // test number, excluded from metrics
const date = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

(async () => {
  await supabase.from("user_logs").delete().eq("phone_number", PHONE);
  await supabase.from("users").upsert({ phone_number: PHONE }, { onConflict: "phone_number" });
  const { error } = await supabase.from("user_logs").insert([
    { phone_number: PHONE, food_name: "Roti / Chapati", matched_db_id: 1, quantity: 2, unit: "piece", kcal: 178, protein: 6, carbs: 33, fat: 3, fiber: 4, meal_time: "lunch", is_estimate: false },
    { phone_number: PHONE, food_name: "Dal Tadka", matched_db_id: 17, quantity: 1, unit: "bowl", kcal: 180, protein: 9, carbs: 20, fat: 7, fiber: 5, meal_time: "lunch", is_estimate: false },
  ]);
  assert.ifError(error);

  const deleted = await deleteAllToday(PHONE);
  assert.strictEqual(deleted.length, 2, "both of today's rows removed");
  assert.strictEqual(deleted.reduce((s, r) => s + r.kcal, 0), 358);

  const { data: left } = await supabase.from("user_logs")
    .select("id").eq("phone_number", PHONE).eq("date", date);
  assert.strictEqual((left || []).length, 0, "day is empty after clear");

  // Second call on an empty day returns [] (server replies "nothing to clear")
  const again = await deleteAllToday(PHONE);
  assert.deepStrictEqual(again, []);

  await supabase.from("users").delete().eq("phone_number", PHONE);
  console.log("undo-all-test: all passed");
})().catch(e => { console.error(e); process.exit(1); });
