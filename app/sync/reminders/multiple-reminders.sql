begin;
alter table public.xiaoye_reminders add column if not exists evening_time time not null default '22:00';
alter table public.xiaoye_reminders add column if not exists morning_enabled boolean not null default true;
alter table public.xiaoye_reminders add column if not exists evening_enabled boolean not null default true;
alter table public.xiaoye_reminders add column if not exists advance_enabled boolean not null default true;
create table if not exists public.xiaoye_notification_runs (
 owner_id uuid not null, run_key text not null, state text not null default 'queued',
 request_ids bigint[], created_at timestamptz not null default now(), primary key(owner_id,run_key)
);
alter table public.xiaoye_notification_runs enable row level security;
revoke all on public.xiaoye_notification_runs from public,anon,authenticated;

create or replace function public.xiaoye_due_notifications(snapshot jsonb,morning time,evening time,morning_on boolean,evening_on boolean,advance_on boolean,local_now timestamp)
returns table(run_key text,content text) language plpgsql set search_path='' as $$
declare d date:=local_now::date; event_day date; e jsonb; starts timestamp; prefs jsonb; advance_minutes integer:=30; lead integer; linked_ids text[];
begin
 select value into prefs from jsonb_array_elements(coalesce(snapshot->'reminderPreferences','[]'::jsonb)) where value->>'id'='reminders';
 if prefs is not null then morning:=(prefs->>'morning')::time; evening:=(prefs->>'evening')::time; advance_minutes:=(prefs->>'advanceMinutes')::integer; end if;
 if morning_on and local_now>=d+morning and local_now<d+morning+interval '10 minutes' then
  run_key:='morning:'||d; content:=public.xiaoye_group_summary(snapshot,d,d); return next;
 end if;
 if evening_on and local_now>=d+evening and local_now<d+evening+interval '10 minutes' then
  run_key:='evening:'||d; content:=public.xiaoye_group_summary(snapshot,d+1,d); return next;
 end if;
 if advance_on then
  for event_day in select d union all select d+1 loop
   for e in select value from jsonb_array_elements(snapshot->'events') loop
    if coalesce(e->>'startTime','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or not public.xiaoye_event_on_day(e,event_day) then continue; end if;
    starts:=event_day+(e->>'startTime')::time;
    lead:=case when coalesce(e->>'reminderLead','') ~ '^\d+$' then (e->>'reminderLead')::integer else advance_minutes end;
    if e->>'reminderLead'='morning' then starts:=event_day+morning; lead:=0; end if;
    if local_now>=starts-make_interval(mins=>lead) and local_now<starts-make_interval(mins=>lead)+interval '10 minutes' then
     run_key:='event:'||coalesce(nullif(e->>'id',''),md5(e::text))||':'||event_day||':'||(e->>'startTime');
     content:=E'【日程提醒】\n'||public.xiaoye_group_summary(snapshot||jsonb_build_object('events',jsonb_build_array(e),'todos','[]'::jsonb),event_day);
     return next;
    end if;
   end loop;
  end loop;
  select array_agg(value->>'todoId') into linked_ids from jsonb_array_elements(snapshot->'events') where coalesce(value->>'startTime','')<>'' and not coalesce((value->>'completed')::boolean,false);
  for e in select value from jsonb_array_elements(snapshot->'todos') loop
   if coalesce((e->>'completed')::boolean,false) or coalesce(e->>'id','')=any(coalesce(linked_ids,array[]::text[])) or coalesce(e->>'targetDate','') !~ '^\d{4}-\d{2}-\d{2}$' or coalesce(e->>'startTime',e->>'targetTime','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then continue; end if;
   starts:=(e->>'targetDate')::date+coalesce(e->>'startTime',e->>'targetTime')::time;
   lead:=case when coalesce(e->>'reminderLead','') ~ '^\d+$' then (e->>'reminderLead')::integer else advance_minutes end;
   if e->>'reminderLead'='morning' then starts:=(e->>'targetDate')::date+morning; lead:=0; end if;
   if local_now>=starts-make_interval(mins=>lead) and local_now<starts-make_interval(mins=>lead)+interval '10 minutes' then
    run_key:='todo:'||(e->>'id')||':'||(e->>'targetDate')||':'||coalesce(e->>'startTime',e->>'targetTime');
    content:=E'【待办提醒】\n'||public.xiaoye_group_summary(snapshot||jsonb_build_object('events','[]'::jsonb,'todos',jsonb_build_array(e)),(e->>'targetDate')::date); return next;
   end if;
  end loop;
 end if;
end $$;
revoke all on function public.xiaoye_due_notifications(jsonb,time,time,boolean,boolean,boolean,timestamp) from public,anon,authenticated;

create or replace function public.xiaoye_dispatch_daily()
returns void language plpgsql security definer set search_path='' as $$
declare p record; item record; sk text; ids bigint[]; rid bigint; inserted integer;
begin
 for p in select r.*,b.snapshot from public.xiaoye_reminders r join public.xiaoye_device_backups b on b.owner_id=r.owner_id and b.device_id=r.device_id where r.enabled loop
  for item in select * from public.xiaoye_due_notifications(p.snapshot,p.send_time,p.evening_time,p.morning_enabled,p.evening_enabled,p.advance_enabled,now() at time zone 'Asia/Shanghai') loop
   begin
    insert into public.xiaoye_notification_runs(owner_id,run_key) values(p.owner_id,item.run_key) on conflict do nothing;
    get diagnostics inserted=row_count;
    if inserted=0 then continue; end if;
    select decrypted_secret into sk from vault.decrypted_secrets where id=case when p.channel='wecom' then p.webhook_secret_id else p.secret_id end;
    if sk is null then
     update public.xiaoye_notification_runs set state='configuration_error' where owner_id=p.owner_id and run_key=item.run_key;
     continue;
    end if;
    if p.channel='wecom' then
     ids:=public.xiaoye_send_group(sk,item.content);
    else
     select net.http_post(url:='https://sctapi.ftqq.com/'||sk||'.send',body:=jsonb_build_object('title',split_part(item.content,E'\n',1),'desp',item.content),headers:='{"Content-Type":"application/json"}'::jsonb,timeout_milliseconds:=10000) into rid;
     ids:=array[rid];
    end if;
    update public.xiaoye_notification_runs set request_ids=ids where owner_id=p.owner_id and run_key=item.run_key;
   exception when others then
    insert into public.xiaoye_notification_runs(owner_id,run_key,state) values(p.owner_id,item.run_key,'dispatch_error') on conflict do nothing;
   end;
  end loop;
 end loop;
end $$;
revoke all on function public.xiaoye_dispatch_daily() from public,anon,authenticated;

do $migration$
declare definition text;
begin
 definition:=pg_get_functiondef('public.xiaoye_reminder_settings(text,jsonb)'::regprocedure);
 if position('multiple_supported' in definition)=0 then
  definition:=replace(definition,$old$  sid:=p.secret_id;$old$,$new$
  if args ? 'evening_time' and coalesce(args->>'evening_time','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'Invalid evening time'; end if;
  sid:=p.secret_id;$new$);
  definition:=replace(definition,$old$ elsif action='test' then$old$,$new$
  update public.xiaoye_reminders set evening_time=coalesce((args->>'evening_time')::time,evening_time), morning_enabled=coalesce((args->>'morning_enabled')::boolean,morning_enabled), evening_enabled=coalesce((args->>'evening_enabled')::boolean,evening_enabled), advance_enabled=coalesce((args->>'advance_enabled')::boolean,advance_enabled) where owner_id=u;
 elsif action='test' then$new$);
  definition:=replace(definition,$old$'group_supported',true$old$,$new$'group_supported',true,'multiple_supported',true,'evening_time',coalesce(p.evening_time,'22:00'::time),'morning_enabled',coalesce(p.morning_enabled,true),'evening_enabled',coalesce(p.evening_enabled,true),'advance_enabled',coalesce(p.advance_enabled,true)$new$);
  execute definition;
 end if;
end $migration$;
commit;
