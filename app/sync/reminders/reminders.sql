begin;
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
commit;
