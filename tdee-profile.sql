-- Persistent state for the on-demand TDEE calculator.
alter table users
  add column if not exists tdee_profile jsonb not null default '{}'::jsonb;

comment on column users.tdee_profile is
  'Validated NutriDesi TDEE inputs, calculation and multi-turn flow state';
