-- Upgrade in place; preserve all existing records and operation IDs.
begin;
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
commit;
