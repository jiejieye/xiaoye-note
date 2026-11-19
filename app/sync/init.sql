-- 小叶便签云端初始化脚本（由 tools/build-init-sql.py 生成，请勿手改）
-- 在 Supabase 项目的 SQL Editor 中粘贴全部内容并点击 Run。整个脚本在一个事务中执行，失败会全部回滚。
begin;
do $guard$ begin
 if to_regclass('public.xiaoye_records') is not null then raise exception '小叶便签数据库已经初始化过了，无需重复执行。'; end if;
end $guard$;
-- ==== supabase.sql ====
-- Run once in a new Supabase project's SQL Editor as the database owner.
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

-- ==== upgrade-v2.sql ====
-- Upgrade in place; preserve all existing records and operation IDs.
alter table public.xiaoye_records drop constraint xiaoye_records_kind_check;
alter table public.xiaoye_records add constraint xiaoye_records_kind_check
check (kind in ('notes','noteFolders','noteLists','todos','todoLists','events','anniversaries','workTrees'));
do $upgrade$
declare definition text;
begin
  if to_regprocedure('public.xiaoye_sync_v2(jsonb)') is not null then
    raise exception 'v2 already installed; no changes applied';
  end if;
  definition := pg_get_functiondef('public.xiaoye_sync(jsonb)'::regprocedure);
  if position('into result from public.xiaoye_records where user_id = who;' in definition) = 0
    or position('(''notes'', ''noteFolders'', ''noteLists'')' in definition) = 0
    or position('if op->>''kind'' = ''notes'' then' in definition) = 0 then
    raise exception 'Unexpected v1 function; migration cancelled';
  end if;
  definition := replace(definition, 'public.xiaoye_sync(', 'public.xiaoye_sync_v2(');
  definition := replace(definition, '(''notes'', ''noteFolders'', ''noteLists'')', '(''notes'', ''noteFolders'', ''noteLists'', ''todos'', ''todoLists'', ''events'', ''anniversaries'', ''workTrees'')');
  definition := replace(definition, 'if op->>''kind'' = ''notes'' then', 'if op->>''kind'' in (''notes'', ''todos'', ''events'', ''anniversaries'', ''workTrees'') then');
  definition := replace(definition, '''protocol'', 1', '''protocol'', 2');
  definition := replace(definition, 'insert into public.xiaoye_records(user_id, kind, id, payload)', $conflict$
    if op->>'kind' = 'todos' then
      conflict_payload := conflict_payload || jsonb_build_object('scheduledEventId', '', 'reminderAt', '');
    elsif op->>'kind' = 'events' then
      conflict_payload := conflict_payload || jsonb_build_object('todoId', '', 'repeatParentId', '', 'reminderAt', '', 'reminderLead', 'none');
    elsif op->>'kind' = 'workTrees' then
      conflict_payload := conflict_payload || jsonb_build_object('tabTitle', coalesce(conflict_payload->>'tabTitle', conflict_payload->>'title') || '（同步冲突副本）', 'nodes',
        (select coalesce(jsonb_agg(n || jsonb_build_object('id', conflict_id || '-' || (n->>'id'),
          'parentId', case when coalesce(n->>'parentId', '') = '' then '' else conflict_id || '-' || (n->>'parentId') end, 'todoId', '') order by ordinal), '[]'::jsonb)
         from jsonb_array_elements(coalesce(conflict_payload->'nodes', '[]'::jsonb)) with ordinality as nodes(n, ordinal)));
    end if;
    insert into public.xiaoye_records(user_id, kind, id, payload)
  $conflict$);
  execute definition;
  -- Old clients continue to see their original three collections only.
  definition := pg_get_functiondef('public.xiaoye_sync(jsonb)'::regprocedure);
  definition := replace(definition, 'into result from public.xiaoye_records where user_id = who;', 'into result from public.xiaoye_records where user_id = who and kind in (''notes'', ''noteFolders'', ''noteLists'');');
  execute definition;
end;
$upgrade$;
revoke all on function public.xiaoye_sync_v2(jsonb) from public, anon;
grant execute on function public.xiaoye_sync_v2(jsonb) to authenticated;

-- ==== device-backup.sql ====
create table if not exists public.xiaoye_device_backups (
  owner_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null,
  device_name text not null,
  snapshot jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (owner_id, device_id)
);
alter table public.xiaoye_device_backups enable row level security;
revoke all on public.xiaoye_device_backups from public, anon, authenticated;
create or replace function public.xiaoye_device_backup(action text, args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); result jsonb; k text;
begin
  if uid is null then raise exception 'Login required'; end if;
  if action = 'upload' then
    if length(trim(args->>'device_name')) not between 1 and 80 or args->>'device_name' is null then raise exception 'Invalid name'; end if;
    if jsonb_typeof(args->'snapshot') is distinct from 'object' then raise exception 'Invalid snapshot'; end if;
    foreach k in array array['notes','noteFolders','noteLists','todos','todoLists','events','anniversaries','workTrees'] loop
      if jsonb_typeof(args->'snapshot'->k) is distinct from 'array' then raise exception 'Invalid collection'; end if;
    end loop;
    insert into public.xiaoye_device_backups(owner_id,device_id,device_name,snapshot)
    values(uid,(args->>'device_id')::uuid,trim(args->>'device_name'),args->'snapshot')
    on conflict(owner_id,device_id) do update set device_name=excluded.device_name,snapshot=excluded.snapshot,updated_at=now();
    return jsonb_build_object('ok',true);
  elsif action = 'list' then
    select coalesce(jsonb_agg(jsonb_build_object('device_id',device_id,'device_name',device_name,'updated_at',updated_at) order by updated_at desc),'[]'::jsonb) into result from public.xiaoye_device_backups where owner_id=uid;
    return result;
  elsif action = 'get' then
    select jsonb_build_object('device_id',device_id,'device_name',device_name,'updated_at',updated_at,'snapshot',snapshot) into result from public.xiaoye_device_backups where owner_id=uid and device_id=(args->>'device_id')::uuid;
    return result;
  end if;
  raise exception 'Invalid action';
end $$;
revoke all on function public.xiaoye_device_backup(text,jsonb) from public, anon;
grant execute on function public.xiaoye_device_backup(text,jsonb) to authenticated;



-- ==== 版本信息（软件“检查”按钮使用，只返回版本号） ====
create or replace function public.xiaoye_schema_info() returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('version', 1, 'reminders', exists(select 1 from pg_proc where proname='xiaoye_reminder_rules' and pronamespace='public'::regnamespace));
$$;
revoke all on function public.xiaoye_schema_info() from public;
grant execute on function public.xiaoye_schema_info() to anon, authenticated;
commit;
