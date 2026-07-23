-- Short-lived NutriDesi handoff state; callers expire it within six hours.
alter table users add column if not exists conversation_state jsonb not null default '{}'::jsonb;
