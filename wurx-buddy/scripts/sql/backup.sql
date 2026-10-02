-- mig 410: the weekly backup's cron rows, config, guards and grants.
-- db-dev.mjs `sql` always rolls back.
--   node scripts/db-dev.mjs sql scripts/sql/backup.sql
create temp table bt (name text, ok boolean, detail text);
create function pg_temp.ok(n text, c boolean, d text default '') returns void language sql as
  $$ insert into bt values (n, coalesce(c, false), d) $$;

select pg_temp.ok('cron: db-backup-start runs Sunday 02:00 GMT, tick every minute',
  (select schedule from cron.job where jobname = 'db-backup-start') = '0 2 * * 0'
  and (select command from cron.job where jobname = 'db-backup-start') like '%backup_start_weekly%'
  and (select schedule from cron.job where jobname = 'db-backup-tick') = '* * * * *'
  and (select active from cron.job where jobname = 'db-backup-tick'),
  coalesce((select string_agg(jobname || ' ' || schedule, '; ') from cron.job where jobname like 'db-backup%'), 'none'));

select pg_temp.ok('app_config.backup_url exists (empty until the function is deployed)',
  exists (select 1 from public.app_config where key = 'backup_url'));

select pg_temp.ok('the bucket db-backups exists and is PRIVATE, with no storage policy',
  (select not public from storage.buckets where id = 'db-backups')
  and not exists (select 1 from pg_policy p join pg_class c on c.oid = p.polrelid
                   join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'storage' and c.relname = 'objects'
                    and pg_get_expr(coalesce(p.polqual, p.polwithcheck), p.polrelid) like '%db-backups%'));

select pg_temp.ok('config: enabled, keep_weeks 8, and the ingestion tables excluded',
  (select backup_enabled and backup_keep_weeks = 8
          and backup_exclude @> array['ai_chunks', 'ai_documents', 'ai_ingest_queue', 'ai_ingest_runs', 'ai_crawl_items',
                                      'ai_crawl_records', 'ai_crawl_state', 'ai_vector_state', 'tts_articles', 'tts_knowledge', 'ai_model_catalog']
     from public.backup_config where id = 1));

select pg_temp.ok('backup_tables() leaves out every excluded table and its own run log',
  not exists (select 1 from public.backup_tables() t
               where t.table_name = any((select backup_exclude from public.backup_config where id = 1) || array['backup_runs']))
  and exists (select 1 from public.backup_tables() t where t.table_name = 'reports')
  and exists (select 1 from public.backup_tables() t where t.table_name = 'employee_compensation'),
  (select count(*)::text || ' tables' from public.backup_tables()));

select pg_temp.ok('backup_tables() knows each primary key (composite ones too)',
  (select pk from public.backup_tables() where table_name = 'reports') = array['id']
  and (select pk from public.backup_tables() where table_name = 'brand_monthly_metrics') = array['brand_id', 'month_key']);

do $$
declare v jsonb; n int; err text;
begin
  -- Guards: one open run at a time, and not twice within 6 hours.
  v := public.backup_start('force');
  perform pg_temp.ok('backup_start opens a run dated in PKT', v->>'status' = 'started'
    and v->>'path' = (now() at time zone 'Asia/Karachi')::date::text, v::text);
  perform pg_temp.ok('a second start while one is open says already_running',
    public.backup_start('force')->>'status' = 'already_running');
  perform pg_temp.ok('the lease is exclusive: a second worker gets nothing',
    public.backup_lease('w1') is not null and public.backup_lease('w2') is null);
  perform pg_temp.ok('only the lease holder may save progress',
    public.backup_save((v->>'id')::bigint, 'w1', '{}'::jsonb, '[]'::jsonb, 1, 1, false)
    and not public.backup_save((v->>'id')::bigint, 'w2', '{}'::jsonb, '[]'::jsonb, 1, 1, false));
  perform public.backup_finish((v->>'id')::bigint, 'done');
  perform pg_temp.ok('right after a run, a new one is too_soon', public.backup_start('schedule')->>'status' = 'too_soon');
  update public.backup_config set backup_enabled = false where id = 1;
  perform pg_temp.ok('disabled: no run is opened', public.backup_start('force')->>'status' = 'disabled');
  update public.backup_config set backup_enabled = true where id = 1;

  -- backup_page refuses anything outside the list (SQL injection included).
  begin perform public.backup_page('ai_chunks', null, 1); err := 'allowed';
  exception when others then err := sqlerrm; end;
  perform pg_temp.ok('backup_page refuses an excluded table', err like '%not a backed-up table%', left(err, 70));
  begin perform public.backup_page('reports"; drop table bt; --', null, 1); err := 'allowed';
  exception when others then err := sqlerrm; end;
  perform pg_temp.ok('backup_page refuses a crafted table name', err like '%not a backed-up table%', left(err, 70));
end $$;

select pg_temp.ok('grants: the worker''s functions are service-role only',
  not has_function_privilege('authenticated', 'public.backup_page(text, jsonb, int)', 'execute')
  and not has_function_privilege('authenticated', 'public.backup_tables()', 'execute')
  and not has_function_privilege('authenticated', 'public.backup_start(text)', 'execute')
  and not has_function_privilege('authenticated', 'public.backup_lease(text)', 'execute')
  and not has_function_privilege('authenticated', 'public.backup_finish(bigint, text, jsonb, bigint, bigint, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.backup_meta()', 'execute')
  and has_function_privilege('service_role', 'public.backup_page(text, jsonb, int)', 'execute'));

select pg_temp.ok('grants: run_db_backup is for signed-in callers (its own check gates it), never anon',
  has_function_privilege('authenticated', 'public.run_db_backup()', 'execute')
  and not has_function_privilege('anon', 'public.run_db_backup()', 'execute')
  and not has_function_privilege('authenticated', 'public.backup_tick()', 'execute')
  and not has_function_privilege('authenticated', 'public.backup_start_weekly()', 'execute'));

select pg_temp.ok('tables: readable by the Boss / developers through RLS, never written by a client',
  (select relrowsecurity from pg_class where oid = 'public.backup_runs'::regclass)
  and (select relrowsecurity from pg_class where oid = 'public.backup_config'::regclass)
  and has_table_privilege('authenticated', 'public.backup_runs', 'select')
  and not has_table_privilege('authenticated', 'public.backup_runs', 'insert')
  and not has_table_privilege('authenticated', 'public.backup_config', 'update')
  and not has_table_privilege('anon', 'public.backup_runs', 'select')
  and (select count(*) from pg_policy where polrelid = 'public.backup_runs'::regclass) = 1);

select name, case when ok then 'PASS' else 'FAIL' end as result, detail from bt;
select case when bool_and(ok) then 'BACKUP: PASS' else 'BACKUP: FAIL' end as verdict,
       count(*) filter (where ok) as ok, count(*) filter (where not ok) as failed from bt;
