-- Opt-in daily summary — the product's only return trigger.
--
-- daily_summary_time already existed in the schema but nothing ever read or
-- wrote it; there was no scheduler at all. This adds the one column needed to
-- guarantee at most one send per IST day.
--
-- Run once in the Supabase SQL editor (same flow as the other migrations here).

-- "HH:MM" in IST, or null when the user has not opted in. Already present in
-- supabase-schema.sql; repeated here so this file stands alone.
alter table users add column if not exists daily_summary_time text;

-- IST date (YYYY-MM-DD) of the last summary actually delivered. The scheduler
-- runs every few minutes, so without this a user would be messaged repeatedly
-- inside the grace window.
alter table users add column if not exists daily_summary_last_sent text;

-- The scheduler scans for opted-in users on every tick.
create index if not exists idx_users_summary_time
  on users (daily_summary_time)
  where daily_summary_time is not null;
