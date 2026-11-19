-- Run once in a new Supabase project's SQL Editor as the database owner.
begin;
create table public.xiaoye_records (
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('notes', 'noteFolders', 'noteLists')),
  id text not null,
  version bigint not null default 1 check (version > 0),
  payload jsonb,
  deleted boolean not null default false,
  primary key (user_id, kind, id)
);
create table public.xiaoye_operations (
  user_id uuid not null references auth.users(id) on delete cascade,
  op_id uuid not null,
  operation jsonb not null,
  primary key (user_id, op_id)
);
alter table public.xiaoye_records enable row level security;
alter table public.xiaoye_operations enable row level security;
-- Clients can only call the authenticated RPC; direct table writes are forbidden.
revoke all on public.xiaoye_records, public.xiaoye_operations from public, anon, authenticated;

create function public.xiaoye_sync(operations jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  who uuid := auth.uid();
  op jsonb;
  previous public.xiaoye_records%rowtype;
  prior_op jsonb;
  current_version bigint;
  conflict_id text;
  conflict_payload jsonb;
  result jsonb;
begin
  if who is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if jsonb_typeof(operations) is distinct from 'array' or jsonb_array_length(operations) > 10000 then
    raise exception 'Invalid operation batch';
  end if;
  -- Serialize each user's batches, including response snapshots, within one transaction.
  perform pg_advisory_xact_lock(hashtextextended(who::text, 0));
  for op in select value from jsonb_array_elements(operations) loop
    if op->>'kind' is null or op->>'kind' not in ('notes', 'noteFolders', 'noteLists')
      or coalesce(length(op->>'id'), 0) not between 1 and 200
      or op->>'opId' is null or op->>'baseVersion' is null
      or (op->>'baseVersion')::bigint < 0
      or jsonb_typeof(op->'deleted') is distinct from 'boolean' then
      raise exception 'Invalid operation';
    end if;
    if not (op->>'deleted')::boolean and (
      jsonb_typeof(op->'payload') is distinct from 'object'
      or op->'payload'->>'id' is distinct from op->>'id'
      or octet_length((op->'payload')::text) > 1048576
      or op->'payload' ? 'attachments') then
      raise exception 'Invalid payload';
    end if;
    select operation into prior_op from public.xiaoye_operations where user_id = who and op_id = (op->>'opId')::uuid;
    if found then
      if prior_op <> op then raise exception 'Operation ID reused'; end if;
      continue;
    end if;
    select * into previous from public.xiaoye_records where user_id = who and kind = op->>'kind' and id = op->>'id';
    current_version := coalesce(previous.version, 0);
    if current_version = (op->>'baseVersion')::bigint then
      insert into public.xiaoye_records(user_id, kind, id, version, payload, deleted)
      values(who, op->>'kind', op->>'id', current_version + 1, op->'payload', (op->>'deleted')::boolean)
      on conflict(user_id, kind, id) do update set version = excluded.version, payload = excluded.payload, deleted = excluded.deleted;
    elsif (not coalesce(previous.deleted, true) and not (op->>'deleted')::boolean and previous.payload = op->'payload')
       or (coalesce(previous.deleted, true) and (op->>'deleted')::boolean) then
      null;
    else
      -- A stale edit becomes a new record; a stale deletion keeps the newer server record.
      conflict_payload := case when (op->>'deleted')::boolean then previous.payload else op->'payload' end;
      if conflict_payload is not null and conflict_payload <> 'null'::jsonb then
        conflict_id := 'conflict-' || (op->>'opId');
        conflict_payload := conflict_payload || jsonb_build_object('id', conflict_id, 'syncConflictOf', op->>'id');
        if op->>'kind' = 'notes' then
          conflict_payload := conflict_payload || jsonb_build_object('title', coalesce(conflict_payload->>'title', '') || '（同步冲突副本）', 'archived', false);
        else
          conflict_payload := conflict_payload || jsonb_build_object('name', coalesce(conflict_payload->>'name', '') || '（同步冲突副本）');
        end if;
        insert into public.xiaoye_records(user_id, kind, id, payload) values(who, op->>'kind', conflict_id, conflict_payload);
      end if;
    end if;
    insert into public.xiaoye_operations(user_id, op_id, operation) values(who, (op->>'opId')::uuid, op);
  end loop;
  select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'id', id, 'version', version, 'payload', payload, 'deleted', deleted) order by kind, id), '[]'::jsonb)
    into result from public.xiaoye_records where user_id = who;
  return jsonb_build_object('protocol', 1, 'rows', result);
end;
$$;
revoke all on function public.xiaoye_sync(jsonb) from public, anon;
grant execute on function public.xiaoye_sync(jsonb) to authenticated;
commit;
