-- Short-lived NutriDesi handoff state; callers expire it within six hours.
alter table users add column if not exists conversation_state jsonb not null default '{}'::jsonb;
create index if not exists idx_msglog_phone_at on message_log (phone_number, at desc);

create or replace function public.claim_conversation_state(p_phone text, p_nonce text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  changed integer;
begin
  update public.users
  set conversation_state = '{}'::jsonb
  where phone_number = p_phone
    and conversation_state->>'nonce' = p_nonce
    and case
      when conversation_state->>'expiresAt'
        ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
      then (conversation_state->>'expiresAt')::timestamptz > now()
      else false
    end;
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;

revoke all on function public.claim_conversation_state(text, text) from public, anon, authenticated;
grant execute on function public.claim_conversation_state(text, text) to service_role;

create or replace function public.clear_conversation_state_if_match(p_phone text, p_state jsonb)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  changed integer;
begin
  update public.users
  set conversation_state = '{}'::jsonb
  where phone_number = p_phone and conversation_state = p_state;
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;

revoke all on function public.clear_conversation_state_if_match(text, jsonb) from public, anon, authenticated;
grant execute on function public.clear_conversation_state_if_match(text, jsonb) to service_role;

create or replace function public.delete_user_logs_exact(p_phone text, p_ids bigint[])
returns setof public.user_logs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  matched integer;
begin
  if p_ids is null
    or cardinality(p_ids) < 1
    or cardinality(p_ids) > 20
    or exists (select 1 from unnest(p_ids) as item(value) where value <= 0)
    or (select count(distinct value) from unnest(p_ids) as item(value)) <> cardinality(p_ids)
  then
    return;
  end if;

  perform 1
  from public.user_logs
  where phone_number = p_phone and id = any(p_ids)
  for update;
  get diagnostics matched = row_count;
  if matched <> cardinality(p_ids) then
    return;
  end if;

  return query
  delete from public.user_logs
  where phone_number = p_phone and id = any(p_ids)
  returning *;
end;
$$;

revoke all on function public.delete_user_logs_exact(text, bigint[]) from public, anon, authenticated;
grant execute on function public.delete_user_logs_exact(text, bigint[]) to service_role;
