-- NutriDesi Supabase schema (run in Supabase SQL Editor)

-- Users: keyed by WhatsApp phone number
create table if not exists users (
  phone_number text primary key,
  name text,
  goal_kcal int default 2000,
  goal_protein int,           -- non-null = user has set a daily goal (goal loop)
  nudge_count int default 0,  -- times we've prompted them to set a goal (capped at 2)
  katori_size text default 'medium',
  roti_size text default 'medium',
  daily_summary_time text,
  created_at timestamptz default now()
);

-- Food database: the 58-item alias table (seeded by scripts, see src/foods.js)
create table if not exists foods (
  id int primary key,
  name text not null,
  aliases text,
  unit text,
  kcal numeric,
  protein numeric,
  carbs numeric,
  fat numeric,
  is_modifier boolean default false
);

-- Every logged food item
create table if not exists user_logs (
  id bigint generated always as identity primary key,
  phone_number text references users(phone_number),
  food_name text,
  matched_db_id int,
  quantity numeric,
  unit text,
  kcal numeric,
  protein numeric,
  carbs numeric,
  fat numeric,
  fiber numeric default 0,
  meal_time text,
  is_estimate boolean default false,
  logged_at timestamptz default now(),
  date date default (now() at time zone 'Asia/Kolkata')::date
);

create index if not exists idx_logs_phone_date on user_logs (phone_number, date);
