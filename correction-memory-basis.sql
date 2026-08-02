-- Basis-aware per-user correction memory.
--
-- Apply this migration BEFORE deploying the Node changes that read/write the
-- new columns. It is additive and keeps the legacy per-unit columns for a
-- straightforward rollback.

begin;

alter table public.correction_memory
  add column if not exists basis_amount numeric,
  add column if not exists basis_unit text,
  add column if not exists protein_per_basis numeric,
  add column if not exists protein_provenance text,
  add column if not exists kcal_per_basis numeric,
  add column if not exists kcal_provenance text,
  add column if not exists source_assertion text,
  add column if not exists source_kind text,
  add column if not exists source_ref text,
  add column if not exists status text not null default 'active';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'correction_memory_basis_pair_check'
      and conrelid = 'public.correction_memory'::regclass
  ) then
    alter table public.correction_memory
      add constraint correction_memory_basis_pair_check check (
        (basis_amount is null and basis_unit is null)
        or (basis_amount > 0 and length(btrim(basis_unit)) between 1 and 20)
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'correction_memory_protein_value_check'
      and conrelid = 'public.correction_memory'::regclass
  ) then
    alter table public.correction_memory
      add constraint correction_memory_protein_value_check
      check (protein_per_basis is null or protein_per_basis between 0 and 500);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'correction_memory_kcal_value_check'
      and conrelid = 'public.correction_memory'::regclass
  ) then
    alter table public.correction_memory
      add constraint correction_memory_kcal_value_check
      check (kcal_per_basis is null or kcal_per_basis between 0 and 10000);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'correction_memory_protein_provenance_check'
      and conrelid = 'public.correction_memory'::regclass
  ) then
    alter table public.correction_memory
      add constraint correction_memory_protein_provenance_check check (
        protein_provenance is null
        or protein_provenance in ('user_confirmed', 'catalog', 'parser_inferred')
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'correction_memory_kcal_provenance_check'
      and conrelid = 'public.correction_memory'::regclass
  ) then
    alter table public.correction_memory
      add constraint correction_memory_kcal_provenance_check check (
        kcal_provenance is null
        or kcal_provenance in ('user_confirmed', 'catalog', 'parser_inferred')
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'correction_memory_source_assertion_check'
      and conrelid = 'public.correction_memory'::regclass
  ) then
    alter table public.correction_memory
      add constraint correction_memory_source_assertion_check
      check (source_assertion is null or length(source_assertion) <= 200);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'correction_memory_status_check'
      and conrelid = 'public.correction_memory'::regclass
  ) then
    alter table public.correction_memory
      add constraint correction_memory_status_check
      check (status in ('active', 'needs_reconfirmation'));
  end if;
end
$$;

-- Backfill the only three pre-migration records. Match by exact food name so
-- no phone number or user identity is embedded in this public repository.
-- The exact variant key is rewritten in the same transaction as its basis.
update public.correction_memory
set food_key = 'chocolate dark high oats protein yogabar',
    basis_amount = 100,
    basis_unit = 'g',
    protein_per_basis = 26,
    protein_provenance = 'user_confirmed',
    kcal_per_basis = 404,
    kcal_provenance = 'catalog',
    source_assertion = '26g protein per 100g',
    source_kind = 'reference',
    source_ref = 'AIS0129',
    status = 'active',
    updated_at = now()
where food_name = 'Yogabar High Protein Oats (Dark Chocolate)';

update public.correction_memory
set food_key = 'fat full milk',
    basis_amount = 350,
    basis_unit = 'ml',
    protein_per_basis = 12,
    protein_provenance = 'user_confirmed',
    kcal_per_basis = 217,
    kcal_provenance = 'user_confirmed',
    source_assertion = '12g protein, 217 kcal per 350ml',
    source_kind = 'curated',
    source_ref = '34',
    status = 'active',
    updated_at = now()
where food_name = 'Milk (Full Fat)';

update public.correction_memory
set food_key = 'plant powder protein',
    basis_amount = 1,
    basis_unit = 'scoop',
    protein_per_basis = 20,
    protein_provenance = 'user_confirmed',
    kcal_per_basis = 120,
    kcal_provenance = 'catalog',
    source_assertion = '20g protein per 1 scoop',
    source_kind = 'curated',
    source_ref = '353',
    status = 'active',
    updated_at = now()
where food_name = 'Plant Protein Powder';

commit;
