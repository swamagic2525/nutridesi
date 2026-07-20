-- Message log — every user⇄bot exchange, powering the dashboard's
-- "Recent conversations" (last 24 h) and future conversation debugging.
-- Raw text lives only here (service key access); the dashboard masks phones.
--
-- Run once in the Supabase SQL editor (same flow as founding-members.sql).

create table if not exists message_log (
  id bigint generated always as identity primary key,
  phone_number text not null,
  body text,                                   -- inbound message (or media caption)
  reply text,                                  -- reply exactly as sent
  media boolean not null default false,
  at timestamptz not null default now()
);

create index if not exists idx_msglog_at on message_log (at desc);

alter table message_log enable row level security;
