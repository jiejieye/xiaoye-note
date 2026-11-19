"""把 app/sync 下的分步 SQL 合并成一次执行的初始化脚本。

init.sql           同步核心（必需）
init-reminders.sql 企业微信提醒（可选，需 pg_cron / pg_net / Vault）

用法：python tools/build-init-sql.py
"""
import pathlib, re

ROOT = pathlib.Path(__file__).resolve().parent.parent
SYNC = ROOT / 'app' / 'sync'
# @private-begin
CORE = ['supabase.sql', 'upgrade-v2.sql', 'device-backup.sql', 'miniprogram-link.sql', 'shared-space.sql', 'goal-flow-reminders.sql']  # 按原部署顺序
# @private-end
# @public CORE = ['supabase.sql', 'upgrade-v2.sql', 'device-backup.sql']
REMINDERS = ['reminders/reminders.sql', 'reminders/goal-task-summary.sql', 'reminders/multiple-reminders.sql', 'reminders/editable-reminders.sql']
SCHEMA_VERSION = 1
PRIVATE_CORE = ()
# @private-begin
PRIVATE_CORE = ('miniprogram-link.sql', 'shared-space.sql', 'goal-flow-reminders.sql')
# @private-end


def body(name):
    text = (SYNC / name).read_text(encoding='utf-8-sig').replace('\r\n', '\n')
    lines = [line for line in text.split('\n') if not re.fullmatch(r'\s*(begin|commit);\s*', line, re.I)]
    sql = f'-- ==== {name} ====\n' + '\n'.join(lines).strip() + '\n'
    if name in PRIVATE_CORE:
        begin = '-- @' + 'private-begin'
        end = '-- @' + 'private-end'
        if begin in sql or end in sql:
            sql = '\n'.join(line for line in sql.split('\n') if begin not in line and end not in line)
        return f'{begin}\n{sql}{end}\n'
    return sql


HEADER = """-- 小叶便签{title}（由 tools/build-init-sql.py 生成，请勿手改）
-- 在 Supabase 项目的 SQL Editor 中粘贴全部内容并点击 Run。整个脚本在一个事务中执行，失败会全部回滚。
begin;
"""

core = HEADER.format(title='云端初始化脚本') + """do $guard$ begin
 if to_regclass('public.xiaoye_records') is not null then raise exception '小叶便签数据库已经初始化过了，无需重复执行。'; end if;
end $guard$;
""" + '\n'.join(body(name) for name in CORE) + f"""-- ==== 版本信息（软件“检查”按钮使用，只返回版本号） ====
create or replace function public.xiaoye_schema_info() returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('version', {SCHEMA_VERSION}, 'reminders', exists(select 1 from pg_proc where proname='xiaoye_reminder_rules' and pronamespace='public'::regnamespace));
$$;
revoke all on function public.xiaoye_schema_info() from public;
grant execute on function public.xiaoye_schema_info() to anon, authenticated;
commit;
"""

reminders = HEADER.format(title='企业微信提醒初始化脚本（可选）') + """do $guard$ begin
 if to_regclass('public.xiaoye_device_backups') is null then raise exception '请先执行 init.sql 完成同步初始化。'; end if;
 if to_regclass('public.xiaoye_reminders') is not null then raise exception '企业微信提醒已经安装过了，无需重复执行。'; end if;
end $guard$;
""" + '\n'.join(body(name) for name in REMINDERS) + 'commit;\n'

(SYNC / 'init.sql').write_text(core, encoding='utf-8')
(SYNC / 'init-reminders.sql').write_text(reminders, encoding='utf-8')
print('init.sql', len(core), 'init-reminders.sql', len(reminders))
