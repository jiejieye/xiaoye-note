begin;
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
commit;
