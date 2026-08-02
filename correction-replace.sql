-- Atomic correction replacement.
--
-- Every correction route currently deletes the original rows and then inserts
-- the replacement in a SEPARATE round trip. A failure between the two — a
-- rejected row, a dropped connection, a Supabase 5xx, the process being killed —
-- leaves the original food deleted and the replacement never written. Awaiting
-- the insert (shipped 1 Aug) made that failure honest instead of silent; it did
-- not make it safe. The data is still gone.
--
-- This does both halves in one transaction: either the originals are replaced,
-- or nothing changes at all.
--
-- Apply this BEFORE deploying the Node changes. If the code ships first every
-- correction fails, because the function will not exist.

create or replace function public.replace_user_logs(
  p_phone      text,
  p_delete_ids bigint[],
  p_rows       jsonb
)
returns setof public.user_logs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  matched     integer;
  n_targets   integer;
  n_dated     integer;
  n_dates     integer;
  v_date      date;
  v_freed     integer[];
  n_freed     integer;
  v_floor     integer;
begin
  -- Deliberate divergence from delete_user_logs_exact, which returns an empty
  -- set on a bad request. This RAISES. A correction that quietly does nothing
  -- while the caller reports success is the exact failure class being fixed
  -- here, so every rejection must be loud and roll the transaction back.

  if p_delete_ids is null
     or cardinality(p_delete_ids) < 1
     or cardinality(p_delete_ids) > 20
     or exists (select 1 from unnest(p_delete_ids) as item(value) where value <= 0)
     or (select count(distinct value) from unnest(p_delete_ids) as item(value))
        <> cardinality(p_delete_ids)
  then
    raise exception 'replace_user_logs: invalid target id set';
  end if;

  -- This function REPLACES. It must never be a back door for creating rows —
  -- ordinary logging already handles that, with its own guards.
  if p_rows is null
     or jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) < 1
     or jsonb_array_length(p_rows) > 20
  then
    raise exception 'replace_user_logs: rows must be a non-empty array of at most 20';
  end if;

  -- Validate the shape UP FRONT so the insert count is guaranteed to match.
  -- Checking afterwards is not an option: RETURN QUERY does not set FOUND (the
  -- documented setters are SELECT INTO, PERFORM, INSERT/UPDATE/DELETE, FETCH,
  -- MOVE and FOR loops), so a post-hoc `if not found` would silently never fire
  -- — which is precisely the class of quiet failure this function exists to end.
  if exists (
    select 1 from jsonb_array_elements(p_rows) as e(value)
    where jsonb_typeof(e.value) <> 'object'
       or coalesce(btrim(e.value ->> 'food_name'), '') = ''
       or (e.value ->> 'kcal') is null
  ) then
    raise exception 'replace_user_logs: every row needs an object shape, a food_name and kcal';
  end if;

  -- Lock the targets, scoped to this user. Ownership is checked by the count
  -- matching: a row belonging to someone else simply will not be locked, so the
  -- request is rejected rather than silently touching a stranger's log.
  perform 1
  from public.user_logs
  where phone_number = p_phone and id = any(p_delete_ids)
  for update;
  get diagnostics matched = row_count;
  if matched <> cardinality(p_delete_ids) then
    raise exception 'replace_user_logs: target rows not found for this user';
  end if;

  -- The log date comes from the locked originals, never from the caller's JSON.
  -- A replacement must land on the same day it replaced, and a set spanning two
  -- days has no single correct answer — so refuse rather than guess.
  --
  -- count(distinct date) alone is NOT sufficient: it ignores nulls, so a target
  -- set of ['2026-08-01', null] counts as one distinct date and would quietly
  -- relocate the null-dated row onto that day. count(date) counts non-nulls, so
  -- comparing it against count(*) rejects any null in the set.
  select count(*), count(date), count(distinct date), min(date)
    into n_targets, n_dated, n_dates, v_date
  from public.user_logs
  where phone_number = p_phone and id = any(p_delete_ids);

  if n_dated <> n_targets then
    raise exception 'replace_user_logs: target rows include an undated entry';
  end if;
  if n_dates <> 1 or v_date is null then
    raise exception 'replace_user_logs: target rows span multiple dates';
  end if;

  -- Item numbers the user has already seen should survive a correction, so the
  -- freed numbers are reused in ascending order: many->1 takes the smallest,
  -- 1->many keeps the original for the first row and appends for the extras.
  select array_agg(day_seq order by day_seq)
    into v_freed
  from public.user_logs
  where phone_number = p_phone and id = any(p_delete_ids) and day_seq is not null;
  n_freed := coalesce(array_length(v_freed, 1), 0);

  delete from public.user_logs
  where phone_number = p_phone and id = any(p_delete_ids);

  -- Extras are numbered above BOTH the surviving rows and the freed numbers.
  -- Taking only the surviving max would collide with a freed number that this
  -- same statement is about to reuse.
  select greatest(
           coalesce(max(day_seq), 0),
           coalesce((select max(v) from unnest(coalesce(v_freed, '{}'::integer[])) as u(v)), 0)
         )
    into v_floor
  from public.user_logs
  where phone_number = p_phone and date = v_date;

  -- phone_number, date, day_seq, id and logged_at are all derived here. Anything
  -- the caller put in the JSON for those fields is ignored: the client does not
  -- get to choose whose log this is, which day it lands on, or its number.
  return query
  -- The column definition list IS the allowlist: any other key in the JSON —
  -- phone_number, id, date, day_seq, logged_at, or a stray transient flag — is
  -- simply not read. WITH ORDINALITY gives a guaranteed index rather than
  -- relying on row_number() following the function's emission order.
  --
  -- ROWS FROM(...) is required, not stylistic. Postgres offers the column
  -- DEFINITION form (`f(...) AS x(col type, ...)`) and the ordinality form
  -- (`f(...) WITH ORDINALITY AS x(col, ...)`) as separate grammar branches, and
  -- the second takes column ALIASES only. Combining a typed record definition
  -- with WITH ORDINALITY is only legal through ROWS FROM, where the types go
  -- inside and the outer alias lists names.
  with incoming as (
    select
      r.ord as idx,
      r.food_name,
      r.matched_db_id,
      r.quantity,
      r.unit,
      r.kcal,
      r.protein,
      r.carbs,
      r.fat,
      r.fiber,
      r.meal_time,
      r.is_estimate
    from rows from (
      jsonb_to_recordset(p_rows) as (
        food_name     text,
        matched_db_id integer,
        quantity      numeric,
        unit          text,
        kcal          numeric,
        protein       numeric,
        carbs         numeric,
        fat           numeric,
        fiber         numeric,
        meal_time     text,
        is_estimate   boolean
      )
    ) with ordinality as r(
      food_name,
      matched_db_id,
      quantity,
      unit,
      kcal,
      protein,
      carbs,
      fat,
      fiber,
      meal_time,
      is_estimate,
      ord
    )
  )
  insert into public.user_logs (
    phone_number, food_name, matched_db_id, quantity, unit,
    kcal, protein, carbs, fat, fiber, meal_time, is_estimate, date, day_seq
  )
  select
    p_phone,
    i.food_name,
    i.matched_db_id,
    i.quantity,
    i.unit,
    i.kcal,
    i.protein,
    i.carbs,
    i.fat,
    coalesce(i.fiber, 0),
    i.meal_time,
    coalesce(i.is_estimate, false),
    v_date,
    case
      when i.idx <= n_freed then v_freed[i.idx]
      else v_floor + (i.idx - n_freed)::integer
    end
  from incoming i
  order by i.idx
  returning *;
end;
$$;

revoke all on function public.replace_user_logs(text, bigint[], jsonb)
  from public, anon, authenticated;
grant execute on function public.replace_user_logs(text, bigint[], jsonb)
  to service_role;

-- NOT SOLVED HERE, deliberately: day_seq allocation still races with ordinary
-- logging. This function allocates its numbers under the row lock it holds, but
-- normal inserts allocate theirs in Node without participating in that lock, so
-- a correction landing at the same moment as a new meal can still collide.
-- Closing that needs every insert to move behind one allocation mechanism, which
-- is separate work and must not be smuggled in here.
