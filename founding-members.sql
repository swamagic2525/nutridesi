-- Founding members — the first 50 waitlist signups get the core tracker free
-- for life (promise made 2026-07-19, announced on nutridesi.co). This table is
-- the durable record of that promise: contact as given on the waitlist, linked
-- to a bot phone_number later when they join the permanent number.
--
-- Run once in the Supabase SQL editor (same flow as foods-reference.sql).

create table if not exists founding_members (
  id bigint generated always as identity primary key,
  contact text not null unique,                -- phone / email / IG handle exactly as submitted
  source text not null default 'waitlist',     -- waitlist | beta | manual
  waitlist_rank int,                           -- 1..50, signup order from Netlify Forms
  phone_number text,                           -- filled when they join the bot
  promised_at timestamptz not null default now()
);

alter table founding_members enable row level security;

-- Marker on bot users, set when a founding member's number is linked.
alter table users add column if not exists is_founding boolean not null default false;
