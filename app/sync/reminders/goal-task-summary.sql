begin;
create or replace function public.xiaoye_task_title(snapshot jsonb,item jsonb)
returns text language plpgsql immutable set search_path='' as $$
declare task jsonb:=item; tree jsonb; node jsonb; parent jsonb; label text;
begin
 if coalesce(item->>'todoId','')<>'' then select value into task from jsonb_array_elements(snapshot->'todos') where value->>'id'=item->>'todoId'; task:=coalesce(task,item); end if;
 if coalesce(task->>'taskType',item->>'taskType','')<>'goal' then return coalesce(item->>'title',''); end if;
 select value into tree from jsonb_array_elements(coalesce(snapshot->'workTrees','[]'::jsonb)) where value->>'id'=task->>'workTreeId';
 select value into node from jsonb_array_elements(tree->'nodes') where value->>'id'=task->>'workTreeNodeId';
 select value into parent from jsonb_array_elements(tree->'nodes') where value->>'id'=node->>'parentId';
 label:=coalesce(parent->>'title',case when node is not null and coalesce(node->>'parentId','')='' then tree->>'title' end,task->>'goalParentTitle',item->>'goalParentTitle','');
 return coalesce(node->>'title',task->>'title',item->>'title','')||case when label<>'' then '－'||label else '' end;
end $$;
revoke all on function public.xiaoye_task_title(jsonb,jsonb) from public,anon,authenticated;
do $migration$
declare definition text;
begin
 definition:=pg_get_functiondef('public.xiaoye_group_summary(jsonb,date,date)'::regprocedure);
 if position('xiaoye_task_title' in definition)=0 then
  definition:=replace(definition,$old$nullif(e->>'title','')$old$,$new$nullif(public.xiaoye_task_title(snapshot,e),'')$new$);
  definition:=replace(definition,$old$nullif(t->>'title','')$old$,$new$nullif(public.xiaoye_task_title(snapshot,t),'')$new$);
  definition:=replace(definition,$old$t->>'targetDate'=day::text;$old$,$new$t->>'targetDate'=day::text and not exists(select 1 from jsonb_array_elements(snapshot->'events') linked where linked->>'todoId'=t->>'id' and public.xiaoye_event_on_day(linked,day));$new$);
  execute definition;
 end if;
end $migration$;
commit;
