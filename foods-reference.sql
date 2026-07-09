-- INDB (Indian Nutrient Databank) reference table — 1,014 recipes, open-access.
-- Tier 2.5 of the fallback chain: consulted when the LLM finds no match in the
-- curated prompt list, before falling back to the LLM's own kcal estimate.
-- Run once in the Supabase SQL Editor, then load data with scripts/import-indb.js.

create extension if not exists pg_trgm;

create table if not exists foods_reference (
  id serial primary key,
  food_code text unique,
  food_name text not null,
  serving_unit text,
  serving_kcal numeric,
  serving_protein numeric,
  serving_carbs numeric,
  serving_fat numeric,
  serving_fibre numeric,
  kcal_100g numeric,
  protein_100g numeric,
  carbs_100g numeric,
  fat_100g numeric,
  fibre_100g numeric
);

create index if not exists foods_reference_name_trgm
  on foods_reference using gin (lower(food_name) gin_trgm_ops);

-- Fuzzy lookup: word_similarity handles short queries against long recipe names
-- ("chai" vs "Hot tea (Garam Chai)"). Strict 0.75 threshold: a false match with
-- confident macros is worse than no match (the LLM estimate is the fallback).
-- Ties prefer rows with real serving data, then the shortest (= most generic) name.
create or replace function match_food(q text)
returns setof foods_reference
language sql stable
as $$
  select *
  from foods_reference
  where word_similarity(lower(q), lower(food_name)) > 0.75
  order by word_similarity(lower(q), lower(food_name)) desc,
           (serving_kcal is null) asc,
           length(food_name) asc
  limit 1;
$$;
