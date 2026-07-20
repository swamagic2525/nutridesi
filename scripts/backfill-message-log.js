// One-off: backfill message_log from the local server log so the dashboard's
// 24-hour conversation view has history from before the table existed.
// Replies weren't captured back then — only inbound text is recoverable.
//
// Usage: node scripts/backfill-message-log.js [hours=24]
require("dotenv").config();
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const LOG = path.join(os.homedir(), "Library/Logs/nutridesi.log");
const hours = Number(process.argv[2]) || 24;
const since = Date.now() - hours * 3600 * 1000;

(async () => {
  const lines = fs.readFileSync(LOG, "utf8").split("\n");
  const re = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) (\+\d+) "(.*)" \d+ms$/;
  const rows = [];
  for (const line of lines) {
    const m = line.match(re);
    if (!m) continue;
    const [, ts, phone, body] = m;
    if (new Date(ts).getTime() < since) continue;
    if (/^\+000|^\+910{5,}/.test(phone)) continue; // test numbers
    rows.push({ phone_number: phone, body: body.slice(0, 500), reply: "(reply not captured — logged before message_log existed)", at: ts });
  }
  if (!rows.length) return console.log("nothing to backfill in the last", hours, "hours");
  const { error } = await supabase.from("message_log").insert(rows);
  if (error) return console.error("backfill failed:", error.message);
  console.log(`backfilled ${rows.length} messages from the last ${hours}h`);
})();
