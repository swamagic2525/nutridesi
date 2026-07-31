// LIVE test — needs Supabase credentials. Uses a synthetic +000 number that is
// excluded from every product metric, and cleans up after itself.
//
// This exists because claimSummarySend is the guard against messaging someone
// repeatedly, and its failure mode lives in SQL semantics rather than in JS, so
// no pure unit test can reach it. The first implementation used `.neq()` alone,
// and `NULL <> '2026-07-31'` evaluates to NULL rather than TRUE in SQL, so a
// brand-new subscriber — last_sent = NULL, i.e. everyone's first ever summary —
// was silently filtered out and could never be claimed. The reminder would have
// shipped sending nothing to anybody, with no error anywhere.
//
//   npm run test:claim

const assert = require("assert");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { supabase, claimSummarySend } = require("../src/db.js");
const { istParts } = require("../src/reminders.js");

const PHONE = "+0000000031";
const { date: TODAY } = istParts(new Date());
const YESTERDAY = (() => {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
})();

const setLastSent = value => supabase.from("users")
  .upsert({ phone_number: PHONE, daily_summary_time: "21:00", daily_summary_last_sent: value },
    { onConflict: "phone_number" });

(async () => {
  try {
    // A first-ever summary: the column is NULL. This is the case the original
    // query dropped.
    await setLastSent(null);
    assert.strictEqual(await claimSummarySend(PHONE, TODAY), true,
      "a fresh subscriber (last_sent NULL) must be claimable — this is everyone's first summary");

    // The claim is what makes it exactly-once.
    assert.strictEqual(await claimSummarySend(PHONE, TODAY), false,
      "a second claim on the same day must fail, or the user gets messaged twice");
    assert.strictEqual(await claimSummarySend(PHONE, TODAY), false, "and a third");

    const { data } = await supabase.from("users")
      .select("daily_summary_last_sent").eq("phone_number", PHONE).maybeSingle();
    assert.strictEqual(data.daily_summary_last_sent, TODAY, "the claim records today's IST date");

    // A new day releases the claim.
    await setLastSent(YESTERDAY);
    assert.strictEqual(await claimSummarySend(PHONE, TODAY), true,
      "yesterday's send must not block today's");

    console.log("summary-claim-test: all passed");
  } finally {
    await supabase.from("users").delete().eq("phone_number", PHONE);
  }
})().catch(e => { console.error(e); process.exit(1); });
