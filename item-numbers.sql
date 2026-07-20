-- Per-day item numbers. Users see "14. Roti ×2" in the reply and can correct
-- it with "undo 14" — addressing a specific row instead of relying on the
-- last-batch heuristic (2026-07-20: a user couldn't remove a bad item from an
-- earlier batch and wiped their whole day instead).
--
-- The number is ASSIGNED AT INSERT, never recomputed. Deleting item 14 leaves a
-- gap rather than renumbering 15 -> 14, so every number a user has already seen
-- in a WhatsApp message stays valid for the rest of that day.
--
-- Run once in the Supabase SQL editor (same flow as message-log.sql).

alter table user_logs add column if not exists day_seq int;

create index if not exists idx_logs_phone_date_seq on user_logs (phone_number, date, day_seq);
