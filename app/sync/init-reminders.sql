-- 小叶便签企业微信提醒初始化脚本（可选）（由 tools/build-init-sql.py 生成，请勿手改）
-- 在 Supabase 项目的 SQL Editor 中粘贴全部内容并点击 Run。整个脚本在一个事务中执行，失败会全部回滚。
begin;
do $guard$ begin
 if to_regclass('public.xiaoye_device_backups') is null then raise exception '请先执行 init.sql 完成同步初始化。'; end if;
 if to_regclass('public.xiaoye_reminders') is not null then raise exception '企业微信提醒已经安装过了，无需重复执行。'; end if;
end $guard$;
-- ==== reminders/reminders.sql ====
create extension if not exists pg_net;
create extension if not exists pg_cron;
create extension if not exists supabase_vault with schema vault;
create table if not exists public.xiaoye_reminders (
 owner_id uuid primary key references auth.users(id), device_id uuid not null,
 send_time time not null default '08:00', enabled boolean not null default false,
 secret_id uuid, updated_at timestamptz not null default now()
);
create table if not exists public.xiaoye_reminder_runs (
 owner_id uuid not null, day date not null, request_id bigint,
 state text not null default 'queued', created_at timestamptz not null default now(),
 primary key(owner_id,day)
);
alter table public.xiaoye_reminders enable row level security;
alter table public.xiaoye_reminders add column if not exists channel text not null default 'serverchan';
alter table public.xiaoye_reminders add column if not exists webhook_secret_id uuid;
alter table public.xiaoye_reminders add column if not exists last_test_at timestamptz;
alter table public.xiaoye_reminder_runs add column if not exists request_ids bigint[];
alter table public.xiaoye_reminder_runs enable row level security;
revoke all on public.xiaoye_reminders,public.xiaoye_reminder_runs from public,anon,authenticated;
create or replace function public.xiaoye_send_group(webhook text,content text)
returns bigint[] language plpgsql set search_path='' as $$
declare chunks text[]:='{}'; part text:=''; ch text; i integer; cut integer; rid bigint; ids bigint[]:='{}';
begin
 if webhook is null or webhook !~ '^https://qyapi[.]weixin[.]qq[.]com/cgi-bin/webhook/send[?]key=[A-Za-z0-9_-]{16,128}$' then raise exception 'Invalid group webhook'; end if;
 for i in 1..char_length(content) loop
  ch:=substr(content,i,1);
  if octet_length(convert_to(part||ch,'UTF8'))>2000 then
   cut:=case when strpos(part,E'\n')>0 then char_length(part)-strpos(reverse(part),E'\n')+1 else char_length(part) end;
   chunks:=array_append(chunks,left(part,cut)); part:=substr(part,cut+1);
  end if;
  part:=part||ch;
 end loop;
 if part<>'' then chunks:=array_append(chunks,part); end if;
 if cardinality(chunks)>20 then raise exception 'Summary exceeds group rate limit'; end if;
 for i in 1..cardinality(chunks) loop
  part:=case when cardinality(chunks)>1 then '('||i||'/'||cardinality(chunks)||')'||E'\n' else '' end||chunks[i];
  select net.http_post(url:=webhook,body:=jsonb_build_object('msgtype','text','text',jsonb_build_object('content',part)),headers:='{"Content-Type":"application/json"}'::jsonb,timeout_milliseconds:=10000) into rid;
  ids:=array_append(ids,rid);
 end loop;
 return ids;
end $$;
revoke all on function public.xiaoye_send_group(text,text) from public,anon,authenticated;
create or replace function public.xiaoye_group_summary(snapshot jsonb,day date,reference_day date)
returns text language plpgsql immutable set search_path='' as $$
declare result text; events text; todos text;
begin
 result:='【'||extract(month from day)::integer||'月'||extract(day from day)::integer||'日 周'||substr('一二三四五六日',extract(isodow from day)::integer,1)||'】';
 select string_agg(
  case when nullif(e->>'startTime','') is not null then '【'||(e->>'startTime')||case when nullif(e->>'endTime','') is not null then '–'||(e->>'endTime') else '' end||'】 ' else '' end||
  translate(left(coalesce(nullif(e->>'title',''),'未命名'),100),E'\r\n','  ')||
  case when nullif(e->>'location','') is not null then '｜'||translate(left(e->>'location',100),E'\r\n','  ') else '' end,
  E'\n' order by nullif(e->>'startTime','') nulls last,n) into events
 from jsonb_array_elements(snapshot->'events') with ordinality as items(e,n) where public.xiaoye_event_on_day(e,day);
 select string_agg(translate(left(coalesce(nullif(t->>'title',''),'未命名'),100),E'\r\n','  '),E'\n' order by n) into todos
 from jsonb_array_elements(snapshot->'todos') with ordinality as items(t,n)
 where not coalesce((t->>'completed')::boolean,false) and t->>'targetDate'=day::text;
 if events is not null then result:=result||E'\n\n【日程】\n'||events; end if;
 if todos is not null then result:=result||E'\n\n【待办】\n'||todos; end if;
 if events is null and todos is null then result:=result||E'\n\n暂无日程和待办'; end if;
 return result;
end $$;
revoke all on function public.xiaoye_group_summary(jsonb,date,date) from public,anon,authenticated;
create or replace function public.xiaoye_group_summary(snapshot jsonb,day date)
returns text language sql immutable set search_path='' as $$
 select public.xiaoye_group_summary(snapshot,day,day);
$$;
revoke all on function public.xiaoye_group_summary(jsonb,date) from public,anon,authenticated;
create or replace function public.xiaoye_reminder_settings(action text,args jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid(); p public.xiaoye_reminders; sid uuid; wid uuid; channel_name text; sk text:=trim(coalesce(args->>'sendkey','')); wh text:=trim(coalesce(args->>'webhook',''));
begin
 if u is null then raise exception 'Login required'; end if;
 perform pg_advisory_xact_lock(hashtextextended(u::text,42));
 select * into p from public.xiaoye_reminders where owner_id=u;
 if action='save' then
  if not exists(select 1 from public.xiaoye_device_backups where owner_id=u and device_id=(args->>'device_id')::uuid) then raise exception 'Choose your own computer'; end if;
  if coalesce(args->>'send_time','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'Invalid time'; end if;
  sid:=p.secret_id;
  wid:=p.webhook_secret_id;
  channel_name:=coalesce(args->>'channel',p.channel,'serverchan');
  if channel_name not in ('serverchan','wecom') then raise exception 'Invalid channel'; end if;
  if wh<>'' then
   if wh !~ '^https://qyapi[.]weixin[.]qq[.]com/cgi-bin/webhook/send[?]key=[A-Za-z0-9_-]{16,128}$' then raise exception 'Invalid group webhook'; end if;
   if wid is null then wid:=vault.create_secret(wh); else perform vault.update_secret(wid,wh); end if;
  end if;
  if sk<>'' then
   if sk !~ '^SCT[0-9A-Za-z]{10,200}$' then raise exception 'Use a valid SCT SendKey'; end if;
   if sid is null then sid:=vault.create_secret(sk); else perform vault.update_secret(sid,sk); end if;
  end if;
  if coalesce((args->>'enabled')::boolean,false) and (case when channel_name='wecom' then wid else sid end) is null then raise exception 'Push credential required'; end if;
  insert into public.xiaoye_reminders(owner_id,device_id,send_time,enabled,secret_id,channel,webhook_secret_id)
   values(u,(args->>'device_id')::uuid,(args->>'send_time')::time,coalesce((args->>'enabled')::boolean,false),sid,channel_name,wid)
   on conflict(owner_id) do update set device_id=excluded.device_id,send_time=excluded.send_time,enabled=excluded.enabled,secret_id=excluded.secret_id,channel=excluded.channel,webhook_secret_id=excluded.webhook_secret_id,updated_at=now();
 elsif action='test' then
  if p.channel is distinct from 'wecom' or p.webhook_secret_id is null then raise exception 'Save group webhook first'; end if;
  if p.last_test_at>now()-interval '1 minute' then raise exception 'Wait one minute before testing again'; end if;
  select decrypted_secret into wh from vault.decrypted_secrets where id=p.webhook_secret_id;
  perform public.xiaoye_send_group(wh,public.xiaoye_group_summary((select snapshot from public.xiaoye_device_backups where owner_id=u and device_id=p.device_id),(now() at time zone 'Asia/Shanghai')::date));
  update public.xiaoye_reminders set last_test_at=now() where owner_id=u;
  return jsonb_build_object('queued',true);
 elsif action<>'get' then raise exception 'Unknown action'; end if;
 select * into p from public.xiaoye_reminders where owner_id=u;
 return jsonb_build_object('device_id',p.device_id,'send_time',p.send_time,'enabled',coalesce(p.enabled,false),'channel',coalesce(p.channel,'serverchan'),'key_configured',p.secret_id is not null,'webhook_configured',p.webhook_secret_id is not null,'group_supported',true);
end $$;
revoke all on function public.xiaoye_reminder_settings(text,jsonb) from public,anon;
grant execute on function public.xiaoye_reminder_settings(text,jsonb) to authenticated;
create or replace function public.xiaoye_event_on_day(e jsonb,d date)
returns boolean language plpgsql immutable set search_path='' as $$
declare s date; r text; i integer; cursor_date date; next_month date;
begin
 if coalesce((e->>'completed')::boolean,false) or coalesce(e->'repeatSkippedDates','[]'::jsonb) ? d::text then return false; end if;
 s:=(e->>'date')::date;
 if s is null or d<s or (nullif(e->>'repeatEndDate','') is not null and d>(e->>'repeatEndDate')::date) then return false; end if;
 if s=d then return true; end if;
 r:=e->>'repeat';
 if r='daily' then return true;
 elsif r='workdays' then return extract(isodow from d)<6;
 elsif r='weekly' then return (d-s)%7=0;
 elsif r in ('monthly','yearly') then
  cursor_date:=s;
  for i in 1..420 loop
   next_month:=(date_trunc('month',cursor_date)+case when r='monthly' then interval '1 month' else interval '12 months' end)::date;
   cursor_date:=next_month+(least(extract(day from cursor_date),extract(day from next_month+interval '1 month - 1 day'))::integer-1);
   if cursor_date=d then return true; end if;
   if cursor_date>d then return false; end if;
  end loop;
 end if;
 return false;
exception when invalid_datetime_format or datetime_field_overflow or invalid_text_representation then return false;
end $$;
revoke all on function public.xiaoye_event_on_day(jsonb,date) from public,anon,authenticated;
create or replace function public.xiaoye_dispatch_daily()
returns void language plpgsql security definer set search_path='' as $$
declare p record; local_now timestamp:=now() at time zone 'Asia/Shanghai'; today date:=local_now::date; sk text; body text; entries text; rid bigint; ids bigint[]; inserted integer;
begin
 for p in select r.*,b.snapshot,b.device_name,b.updated_at as uploaded_at from public.xiaoye_reminders r join public.xiaoye_device_backups b on b.owner_id=r.owner_id and b.device_id=r.device_id where r.enabled and today+r.send_time<=local_now and local_now<today+r.send_time+interval '10 minutes' loop
  begin
   insert into public.xiaoye_reminder_runs(owner_id,day) values(p.owner_id,today) on conflict do nothing;
   get diagnostics inserted=row_count;
   if inserted=0 then continue; end if;
   select decrypted_secret into sk from vault.decrypted_secrets where id=case when p.channel='wecom' then p.webhook_secret_id else p.secret_id end;
   if sk is null or (p.channel='serverchan' and sk !~ '^SCT[0-9A-Za-z]{10,200}$') then
    update public.xiaoye_reminder_runs set state='configuration_error' where owner_id=p.owner_id and day=today;
    continue;
   end if;
   select string_agg(line,E'\n' order by sort_key) into entries from (
    select coalesce(e->>'startTime','') as sort_key,'- 日程 '||coalesce(e->>'startTime','')||' '||left(coalesce(e->>'title','未命名'),100)||' '||left(coalesce(e->>'location',''),100) as line from jsonb_array_elements(p.snapshot->'events') e where public.xiaoye_event_on_day(e,today)
    union all
    select '99','- 待办 '||left(coalesce(t->>'title','未命名'),100) from jsonb_array_elements(p.snapshot->'todos') t where not coalesce((t->>'completed')::boolean,false) and t->>'targetDate'=today::text
   ) items;
   body:='来源：'||p.device_name||E'\n最后上传：'||to_char(p.uploaded_at at time zone 'Asia/Shanghai','YYYY-MM-DD HH24:MI')||E'\n\n'||left(coalesce(entries,'今天暂无已安排的未完成事项。'),12000);
   if p.channel='wecom' then
    ids:=public.xiaoye_send_group(sk,public.xiaoye_group_summary(p.snapshot,today));
   else
    select net.http_post(url:='https://sctapi.ftqq.com/'||sk||'.send',body:=jsonb_build_object('title','今日工作 · '||today::text,'desp',body),headers:='{"Content-Type":"application/json"}'::jsonb,timeout_milliseconds:=10000) into rid;
    ids:=array[rid];
   end if;
   update public.xiaoye_reminder_runs set request_id=ids[1],request_ids=ids where owner_id=p.owner_id and day=today;
  exception when others then
   insert into public.xiaoye_reminder_runs(owner_id,day,state) values(p.owner_id,today,'dispatch_error') on conflict do nothing;
  end;
 end loop;
end $$;
revoke all on function public.xiaoye_dispatch_daily() from public,anon,authenticated;
select cron.schedule('xiaoye-daily-summary','* * * * *','select public.xiaoye_dispatch_daily();');

-- ==== reminders/goal-task-summary.sql ====
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

-- ==== reminders/multiple-reminders.sql ====
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

-- ==== reminders/editable-reminders.sql ====
alter table public.xiaoye_reminders add column if not exists rules jsonb;
alter table public.xiaoye_reminders add column if not exists rules_version bigint not null default 0;
alter table public.xiaoye_reminders add column if not exists rules_activated_at timestamptz;

create table if not exists public.xiaoye_reminder_function_backups (
 migration text not null, signature text not null, definition text not null,
 created_at timestamptz not null default now(), primary key(migration,signature)
);
alter table public.xiaoye_reminder_function_backups enable row level security;
revoke all on public.xiaoye_reminder_function_backups from public,anon,authenticated;
insert into public.xiaoye_reminder_function_backups(migration,signature,definition)
 select 'editable-reminders-v1','public.xiaoye_dispatch_daily()',pg_get_functiondef('public.xiaoye_dispatch_daily()'::regprocedure)
 on conflict do nothing;

create or replace function public.xiaoye_reminder_event_on_day(e jsonb,d date)
returns boolean language plpgsql immutable set search_path='' as $$
declare first_day date; repeat_kind text; last_day integer;
begin
 first_day:=nullif(e->>'date','')::date;
 if coalesce((e->>'completed')::boolean,false) or first_day is null or d<first_day or coalesce(e->'repeatSkippedDates','[]'::jsonb) ? d::text then return false; end if;
 if coalesce((e->>'ongoing')::boolean,false) or d=first_day then return true; end if;
 if nullif(e->>'repeatEndDate','') is not null and d>(e->>'repeatEndDate')::date then return false; end if;
 repeat_kind:=e->>'repeat';
 if repeat_kind='daily' then return true;
 elsif repeat_kind in ('workdays','weekday','weekdays','workday') then return extract(isodow from d)<6;
 elsif repeat_kind='weekly' then return (d-first_day)%7=0;
 elsif repeat_kind in ('monthly','yearly') then
  if repeat_kind='yearly' and extract(month from d)<>extract(month from first_day) then return false; end if;
  last_day:=extract(day from date_trunc('month',d)+interval '1 month - 1 day')::integer;
  return extract(day from d)=least(extract(day from first_day)::integer,last_day);
 end if;
 return false;
exception when invalid_datetime_format or datetime_field_overflow or invalid_text_representation then return false;
end $$;
revoke all on function public.xiaoye_reminder_event_on_day(jsonb,date) from public,anon,authenticated;

create or replace function public.xiaoye_normalize_reminder_rules(items jsonb)
returns jsonb language plpgsql immutable set search_path='' as $$
declare item jsonb; result jsonb:='[]'; ids text[]:='{}'; source jsonb; sources jsonb; rule_id text; label text; mode_name text; at_time text; day_range text; lead text; format text;
begin
 if jsonb_typeof(items) is distinct from 'array' or jsonb_array_length(items)>20 then raise exception '最多设置 20 条提醒'; end if;
 for item in select value from jsonb_array_elements(items) loop
  if jsonb_typeof(item) is distinct from 'object' then raise exception 'Invalid reminder rule'; end if;
  rule_id:=coalesce(item->>'id',''); label:=trim(coalesce(item->>'name',''));
  mode_name:=coalesce(item->>'mode','daily'); at_time:=coalesce(item->>'time','08:00'); day_range:=coalesce(item->>'range','today'); lead:=coalesce(item->>'advanceMinutes','30'); format:=coalesce(item->>'template','');
  if rule_id !~ '^[A-Za-z0-9_-]{1,100}$' or rule_id=any(ids) or char_length(label) not between 1 and 60 then raise exception 'Invalid reminder name or id'; end if;
  if mode_name not in ('daily','advance') or at_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or lead !~ '^\d{1,4}$' or lead::integer not between 0 and 1440 then raise exception 'Invalid reminder time'; end if;
  if day_range not in ('today','tomorrow') or char_length(trim(format))=0 or char_length(format)>2000 then raise exception 'Invalid reminder format or range'; end if;
  if item ? 'enabled' and jsonb_typeof(item->'enabled')<>'boolean' or item ? 'skipEmpty' and jsonb_typeof(item->'skipEmpty')<>'boolean' then raise exception 'Invalid reminder switch'; end if;
  if item ? 'sources' and jsonb_typeof(item->'sources')<>'array' then raise exception 'Invalid reminder sources'; end if;
  sources:='[]';
  for source in select value from jsonb_array_elements(coalesce(item->'sources','[]')) loop
   if jsonb_typeof(source)<>'string' or source#>>'{}' not in ('events','todos') then raise exception 'Invalid reminder source'; end if;
   if not sources @> jsonb_build_array(source) then sources:=sources||jsonb_build_array(source); end if;
  end loop;
  if mode_name='advance' and (jsonb_array_length(sources)=0 or day_range<>'today') then raise exception '提前提醒必须选择内容并使用今天范围'; end if;
  result:=result||jsonb_build_array(jsonb_build_object('id',rule_id,'name',label,'mode',mode_name,'time',at_time,'advanceMinutes',lead::integer,'range',day_range,'sources',sources,'enabled',coalesce((item->>'enabled')::boolean,true),'template',format,'skipEmpty',coalesce((item->>'skipEmpty')::boolean,true)));
  ids:=array_append(ids,rule_id);
 end loop;
 return result;
end $$;
revoke all on function public.xiaoye_normalize_reminder_rules(jsonb) from public,anon,authenticated;

create or replace function public.xiaoye_default_reminder_rules(p public.xiaoye_reminders,snapshot jsonb)
returns jsonb language plpgsql immutable set search_path='' as $$
declare prefs jsonb; morning text:=to_char(coalesce(p.send_time,'08:00'::time),'HH24:MI'); evening text:=to_char(coalesce(p.evening_time,'22:00'::time),'HH24:MI'); lead integer:=30; format text:=E'【{提醒名称}】\n{日期} {星期}\n\n【日程】\n{日程}\n\n【待办】\n{待办}';
begin
 select value into prefs from jsonb_array_elements(coalesce(snapshot->'reminderPreferences','[]')) where value->>'id'='reminders' limit 1;
 if coalesce(prefs->>'morning','') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then morning:=prefs->>'morning'; end if;
 if coalesce(prefs->>'evening','') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then evening:=prefs->>'evening'; end if;
 if coalesce(prefs->>'advanceMinutes','') ~ '^\d{1,4}$' and (prefs->>'advanceMinutes')::integer between 0 and 1440 then lead:=(prefs->>'advanceMinutes')::integer; end if;
 return public.xiaoye_normalize_reminder_rules(jsonb_build_array(
  jsonb_build_object('id','morning','name','今日事项','mode','daily','time',morning,'range','today','sources',jsonb_build_array('events','todos'),'enabled',coalesce(p.morning_enabled,true),'template',format),
  jsonb_build_object('id','evening','name','明日事项','mode','daily','time',evening,'range','tomorrow','sources',jsonb_build_array('events','todos'),'enabled',coalesce(p.evening_enabled,true),'template',format),
  jsonb_build_object('id','advance','name','事项提前提醒','mode','advance','time',morning,'advanceMinutes',lead,'range','today','sources',jsonb_build_array('events','todos'),'enabled',coalesce(p.advance_enabled,true),'template',format)
 ));
end $$;
revoke all on function public.xiaoye_default_reminder_rules(public.xiaoye_reminders,jsonb) from public,anon,authenticated;

create or replace function public.xiaoye_reminder_rules(action text,args jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid(); p public.xiaoye_reminders; snapshot jsonb; device uuid; cleaned jsonb;
begin
 if u is null then raise exception 'Login required'; end if;
 if action not in ('get','save') or action is null then raise exception 'Unknown action'; end if;
 perform pg_advisory_xact_lock(hashtextextended(u::text,42));
 select * into p from public.xiaoye_reminders where owner_id=u;
 device:=p.device_id;
 select b.snapshot into snapshot from public.xiaoye_device_backups b where b.owner_id=u and b.device_id=device;
 if action='save' then
  if p.owner_id is null then raise exception '请先保存企微提醒连接'; end if;
  if jsonb_typeof(args->'version') is distinct from 'number' or coalesce(args->>'version','') !~ '^\d{1,16}$' then raise exception 'Invalid reminder version'; end if;
  cleaned:=public.xiaoye_normalize_reminder_rules(args->'rules');
  if (args->>'version')::bigint<>p.rules_version then
   if (args->>'version')::bigint<p.rules_version and cleaned=p.rules then return jsonb_build_object('rules',p.rules,'version',p.rules_version,'configured',true); end if;
   return jsonb_build_object('conflict',true,'rules',coalesce(p.rules,public.xiaoye_default_reminder_rules(p,snapshot)),'version',p.rules_version);
  end if;
  update public.xiaoye_reminders set rules=cleaned,rules_version=rules_version+1,rules_activated_at=coalesce(rules_activated_at,now()),updated_at=now() where owner_id=u returning * into p;
 end if;
 return jsonb_build_object('rules',coalesce(p.rules,public.xiaoye_default_reminder_rules(p,snapshot)),'version',coalesce(p.rules_version,0),'configured',p.rules is not null);
end $$;
revoke all on function public.xiaoye_reminder_rules(text,jsonb) from public,anon;
grant execute on function public.xiaoye_reminder_rules(text,jsonb) to authenticated;

do $migration$
begin
 if to_regprocedure('public.xiaoye_task_title(jsonb,jsonb)') is null then
  execute $definition$
   create function public.xiaoye_task_title(snapshot jsonb,item jsonb)
   returns text language plpgsql immutable set search_path='' as $body$
   declare task jsonb:=item; tree jsonb; node jsonb; parent jsonb; label text;
   begin
    if coalesce(item->>'todoId','')<>'' then select value into task from jsonb_array_elements(snapshot->'todos') where value->>'id'=item->>'todoId'; task:=coalesce(task,item); end if;
    if coalesce(task->>'taskType',item->>'taskType','')<>'goal' then return coalesce(item->>'title',''); end if;
    select value into tree from jsonb_array_elements(coalesce(snapshot->'workTrees','[]'::jsonb)) where value->>'id'=task->>'workTreeId';
    select value into node from jsonb_array_elements(tree->'nodes') where value->>'id'=task->>'workTreeNodeId';
    select value into parent from jsonb_array_elements(tree->'nodes') where value->>'id'=node->>'parentId';
    label:=coalesce(parent->>'title',case when node is not null and coalesce(node->>'parentId','')='' then tree->>'title' end,task->>'goalParentTitle',item->>'goalParentTitle','');
    return coalesce(node->>'title',task->>'title',item->>'title','')||case when label<>'' then '－'||label else '' end;
   end $body$;
  $definition$;
  revoke all on function public.xiaoye_task_title(jsonb,jsonb) from public,anon,authenticated;
 end if;
end $migration$;

create or replace function public.xiaoye_render_reminder_rule(snapshot jsonb,rule jsonb,today date,for_day date default null)
returns table(content text,has_content boolean) language plpgsql immutable set search_path='' as $$
declare day date:=coalesce(for_day,case when rule->>'range'='tomorrow' then today+1 else today end); events text; todos text; sources jsonb:=rule->'sources'; variables jsonb; format text:=rule->>'template'; matched text[]; offset_at integer; token text;
begin
 if sources ? 'events' then
  select string_agg(trim(coalesce(e->>'startTime','')||' '||translate(coalesce(nullif(public.xiaoye_task_title(snapshot,e),''),'未命名'),E'\r\n','  ')),E'\n' order by nullif(e->>'startTime','') nulls last,n) into events
   from jsonb_array_elements(coalesce(snapshot->'events','[]')) with ordinality as items(e,n)
   where public.xiaoye_reminder_event_on_day(e,day);
 end if;
 if sources ? 'todos' then
  select string_agg(trim(coalesce(nullif(t->>'startTime',''),t->>'targetTime','')||' '||translate(coalesce(nullif(public.xiaoye_task_title(snapshot,t),''),'未命名'),E'\r\n','  ')),E'\n' order by n) into todos
   from jsonb_array_elements(coalesce(snapshot->'todos','[]')) with ordinality as items(t,n)
   where not coalesce((t->>'completed')::boolean,false) and t->>'targetDate'=day::text
    and (not sources ? 'events' or not exists(select 1 from jsonb_array_elements(coalesce(snapshot->'events','[]')) e where e->>'todoId'=t->>'id' and public.xiaoye_reminder_event_on_day(e,day)));
 end if;
 has_content:=events is not null or todos is not null or jsonb_array_length(sources)=0;
 variables:=jsonb_build_object('提醒名称',rule->>'name','日期',to_char(day,'FMMM.FMDD'),'星期','周'||substr('一二三四五六日',extract(isodow from day)::integer,1),'日程',events,'待办',todos);
 content:='';
 loop
  matched:=regexp_match(format,'\{(提醒名称|日期|星期|日程|待办)\}');
  if matched is null then content:=content||format; exit; end if;
  token:='{'||matched[1]||'}'; offset_at:=strpos(format,token);
  content:=content||left(format,offset_at-1)||coalesce(nullif(variables->>matched[1],''),'暂无');
  format:=substr(format,offset_at+char_length(token));
 end loop;
 return next;
end $$;
revoke all on function public.xiaoye_render_reminder_rule(jsonb,jsonb,date,date) from public,anon,authenticated;

create or replace function public.xiaoye_due_reminder_rules(snapshot jsonb,rules jsonb,local_now timestamp)
returns table(run_key text,content text) language plpgsql immutable set search_path='' as $$
declare today date:=local_now::date; day date; rule jsonb; item jsonb; rendered record; starts timestamp; lead integer; item_time text; item_id text; subset jsonb; selected jsonb; legacy boolean; event_selected boolean;
begin
 for rule in select value from jsonb_array_elements(rules) loop
  if not coalesce((rule->>'enabled')::boolean,true) then continue; end if;
  if rule->>'mode'='daily' then
   if local_now<today+(rule->>'time')::time or local_now>=today+(rule->>'time')::time+interval '10 minutes' then continue; end if;
   select * into rendered from public.xiaoye_render_reminder_rule(snapshot,rule,today);
   if coalesce((rule->>'skipEmpty')::boolean,true) and not rendered.has_content then continue; end if;
   run_key:=case when rule->>'id' in ('morning','evening') then (rule->>'id')||':'||today else 'rule:'||(rule->>'id')||':'||today end;
   content:=rendered.content; return next;
  else
   legacy:=rule->>'id'='advance';
   for day in select today union all select today+1 loop
    for item in select value from jsonb_array_elements(coalesce(snapshot->'events','[]')) loop
     selected:=rule->'sources';
     event_selected:=selected ? 'events';
     item_time:=coalesce(item->>'startTime','');
     if not event_selected or item_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or not public.xiaoye_reminder_event_on_day(item,day) then continue; end if;
     starts:=day+item_time::time; lead:=(rule->>'advanceMinutes')::integer;
     if legacy and coalesce(item->>'reminderLead','') ~ '^\d{1,4}$' and (item->>'reminderLead')::integer between 0 and 1440 then lead:=(item->>'reminderLead')::integer; end if;
     if legacy and item->>'reminderLead'='morning' then starts:=day+(rule->>'time')::time; lead:=0; end if;
     if local_now<starts-make_interval(mins=>lead) or local_now>=starts-make_interval(mins=>lead)+interval '10 minutes' then continue; end if;
     subset:=snapshot||jsonb_build_object('events',jsonb_build_array((item-'repeat'-'repeatEndDate'-'repeatSkippedDates')||jsonb_build_object('date',day::text)),'todos',coalesce((select jsonb_agg(t) from jsonb_array_elements(coalesce(snapshot->'todos','[]')) t where t->>'id'=item->>'todoId'),'[]'::jsonb));
     select * into rendered from public.xiaoye_render_reminder_rule(subset,rule,today,day);
     if coalesce((rule->>'skipEmpty')::boolean,true) and not rendered.has_content then continue; end if;
     item_id:=coalesce(nullif(item->>'id',''),md5(item::text));
     run_key:=case when legacy then '' else 'rule:'||(rule->>'id')||':' end||'event:'||item_id||':'||day||':'||item_time;
     content:=rendered.content; return next;
    end loop;
   end loop;
   if not rule->'sources' ? 'todos' then continue; end if;
   for item in select value from jsonb_array_elements(coalesce(snapshot->'todos','[]')) loop
    item_time:=coalesce(nullif(item->>'startTime',''),item->>'targetTime','');
    if coalesce((item->>'completed')::boolean,false) or coalesce(item->>'targetDate','') !~ '^\d{4}-\d{2}-\d{2}$' or item_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then continue; end if;
    day:=(item->>'targetDate')::date;
    if day not between today and today+1 then continue; end if;
    if rule->'sources' ? 'events' and exists(select 1 from jsonb_array_elements(coalesce(snapshot->'events','[]')) e where e->>'todoId'=item->>'id' and coalesce(e->>'startTime','') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and public.xiaoye_reminder_event_on_day(e,day)) then continue; end if;
    starts:=day+item_time::time; lead:=(rule->>'advanceMinutes')::integer;
    if legacy and coalesce(item->>'reminderLead','') ~ '^\d{1,4}$' and (item->>'reminderLead')::integer between 0 and 1440 then lead:=(item->>'reminderLead')::integer; end if;
    if legacy and item->>'reminderLead'='morning' then starts:=day+(rule->>'time')::time; lead:=0; end if;
    if local_now<starts-make_interval(mins=>lead) or local_now>=starts-make_interval(mins=>lead)+interval '10 minutes' then continue; end if;
    subset:=snapshot||jsonb_build_object('events','[]'::jsonb,'todos',jsonb_build_array(item));
    select * into rendered from public.xiaoye_render_reminder_rule(subset,rule,today,day);
    if coalesce((rule->>'skipEmpty')::boolean,true) and not rendered.has_content then continue; end if;
    run_key:=case when legacy then '' else 'rule:'||(rule->>'id')||':' end||'todo:'||coalesce(nullif(item->>'id',''),md5(item::text))||':'||day||':'||item_time;
    content:=rendered.content; return next;
   end loop;
  end if;
 end loop;
end $$;
revoke all on function public.xiaoye_due_reminder_rules(jsonb,jsonb,timestamp) from public,anon,authenticated;

create or replace function public.xiaoye_dispatch_daily()
returns void language plpgsql security definer set search_path='' as $$
declare p record; item record; sk text; ids bigint[]; rid bigint; inserted integer; device uuid; snapshot jsonb; local_now timestamp:=now() at time zone 'Asia/Shanghai';
begin
 for p in select * from public.xiaoye_reminders where enabled loop
  device:=p.device_id;
  select b.snapshot into snapshot from public.xiaoye_device_backups b where b.owner_id=p.owner_id and b.device_id=device;
  if snapshot is null then continue; end if;
  for item in
   select * from public.xiaoye_due_reminder_rules(snapshot,p.rules,local_now) where p.rules is not null
   union all
   select * from public.xiaoye_due_notifications(snapshot,p.send_time,p.evening_time,p.morning_enabled,p.evening_enabled,p.advance_enabled,local_now) where p.rules is null
  loop
   begin
    insert into public.xiaoye_notification_runs(owner_id,run_key) values(p.owner_id,item.run_key) on conflict do nothing;
    get diagnostics inserted=row_count;
    if inserted=0 then continue; end if;
    select decrypted_secret into sk from vault.decrypted_secrets where id=case when p.channel='wecom' then p.webhook_secret_id else p.secret_id end;
    if sk is null then update public.xiaoye_notification_runs set state='configuration_error' where owner_id=p.owner_id and run_key=item.run_key; continue; end if;
    if p.channel='wecom' then ids:=public.xiaoye_send_group(sk,item.content);
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
commit;
