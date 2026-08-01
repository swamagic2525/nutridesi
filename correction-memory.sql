-- Per-user correction memory.
--
-- CLAUDE.md rule 1: "One clarifying question per food type, ever. Once answered,
-- remembered permanently." That was not true for macros. A real user restated
-- the same figure on five consecutive days (27, 28, 30, 31 July, 1 August):
-- their Yogabar high-protein oats is 26g protein per 100g, the database says 15,
-- and every morning they had to say so again.
--
-- Deliberately PER USER and never written back to foods_reference or foods.js.
-- One person's label reading must not silently become everyone's nutrition
-- truth: they may be reading a different variant, a reformulated pack, or simply
-- be wrong. The shared tiers stay curated; this only changes what THIS user sees.
--
-- Run once in the Supabase SQL editor.

create table if not exists correction_memory (
  id bigint generated always as identity primary key,
  phone_number text not null,
  -- Normalised resolved food name — what the bot logged it AS, not what the
  -- user typed, so "yogabar oats" and "yogabar high protein oats" share a key.
  food_key text not null,
  -- Display name, for the note shown when the memory is applied.
  food_name text not null,
  -- Stored per single unit of whatever `unit` is, so quantity scales normally.
  protein_per_unit numeric,
  kcal_per_unit numeric,
  unit text,
  times_applied int not null default 0,
  set_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (phone_number, food_key)
);

create index if not exists idx_correction_memory_phone
  on correction_memory (phone_number);

alter table correction_memory enable row level security;
