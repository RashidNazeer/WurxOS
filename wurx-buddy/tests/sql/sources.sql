-- ============================================================
-- ai_assistant_config.ingest_sources robustness: mig 377, 379 (ignore-and-report
-- net), 380 (save-time refusal, trigger ai_assistant_config_sources_check).
-- Needs 379 + 380. Before they are applied on dev:
--   node tests/run-with-migrations.mjs --mig 379,380 tests/sql/sources.sql
-- After:  node scripts/db-dev.mjs sql tests/sql/sources.sql      (always rolled back)
--
-- Real source rows are read (reconcile / backfill enqueue into the queue of
-- THIS transaction only); nothing persists.
-- ============================================================
create temp table xres (n serial, test text, result text, detail text) on commit drop;
create function pg_temp.ok(t text, cond boolean, d text default null) returns void language sql as $$
  insert into xres (test, result, detail) values (t, case when cond then 'ok' else 'FAIL' end, d);
$$;

do $$
declare outcome text; v jsonb; code text; has380 boolean; bad text[]; good text[]; x text[];
begin
  has380 := exists (select 1 from pg_trigger where tgname = 'ai_assistant_config_sources_check' and not tgisinternal);
  perform pg_temp.ok('precondition: 379 + 380 present (ai_source_canon, the save-time trigger)',
    has380 and exists (select 1 from pg_proc where proname = 'ai_source_canon'), 'run with tests/run-with-migrations.mjs --mig 379,380');
  if not has380 then return; end if;

  -- baseline: a clean list reconciles fine
  update ai_assistant_config set ingest_sources = '{tts_article}' where id = 1;
  begin v := ai_reconcile(500); outcome := 'ok ' || v::text;
  exception when others then outcome := 'RAISED ' || sqlerrm; end;
  perform pg_temp.ok('baseline: ai_reconcile() with {tts_article} runs', outcome like 'ok%', left(outcome, 200));

  -- 380: an admin typo is refused when saved (23514), naming the bad name and the allowed list
  begin
    update ai_assistant_config set ingest_sources = '{tts_article,kb_articles}' where id = 1;
    outcome := 'accepted'; code := null;
  exception when others then outcome := sqlerrm; code := sqlstate; end;
  perform pg_temp.ok('380: a typo (kb_articles) is refused at save time with 23514, message names it and the allowed list',
    code = '23514' and outcome ~ 'kb_articles' and outcome ~ 'allowed: kb_article, ai_doc, app_guide, tts_article, report, incentive', coalesce(code, '') || ' ' || outcome);
  begin
    update ai_assistant_config set ingest_sources = '{tts_article,payroll}' where id = 1;
    outcome := 'accepted'; code := null;
  exception when others then outcome := sqlerrm; code := sqlstate; end;
  perform pg_temp.ok('380: a sensitive name (payroll) is refused at save time (23514)', code = '23514', coalesce(code, '') || ' ' || outcome);

  -- every refused shape
  foreach bad slice 1 in array array[
      array['Report', 'x'], array['kb_article ', 'x'], array['', 'x'], array['qa_salary_x', 'x'], array['zzz_payroll', 'x'],
      array['srch_attendance', 'x'], array['employee_compensation', 'x'], array['report;drop', 'x'], array['acltest2', 'x']] loop
    begin
      update ai_assistant_config set ingest_sources = array[bad[1]] where id = 1;
      outcome := 'accepted'; code := null;
    exception when others then outcome := sqlerrm; code := sqlstate; end;
    perform pg_temp.ok(format('380: %L refused at save time', bad[1]), code = '23514', coalesce(code, '') || ' ' || left(outcome, 120));
  end loop;
  begin
    update ai_assistant_config set ingest_sources = array['report', null] where id = 1;
    outcome := 'accepted'; code := null;
  exception when others then outcome := sqlerrm; code := sqlstate; end;
  perform pg_temp.ok('380: a NULL element is refused (23514, shown as <null>)', code = '23514' and outcome ~ '<null>', coalesce(code, '') || ' ' || outcome);

  -- a second config row cannot smuggle a bad name either (BEFORE INSERT)
  begin
    insert into ai_assistant_config (id, ingest_sources) values (99, '{payroll}');
    outcome := 'accepted'; code := null;
  exception when others then outcome := sqlerrm; code := sqlstate; end;
  perform pg_temp.ok('380: INSERT of a config row with a bad name refused (23514)', code = '23514', coalesce(code, '') || ' ' || left(outcome, 120));

  -- accepted shapes: canon, empty, duplicates, test-fixture hook
  foreach good slice 1 in array array[
      array['kb_article', 'ai_doc', 'app_guide', 'tts_article', 'report', 'incentive'],
      array['qa_test', 'zzz_custom', 'srchtest', 'acltest', 'report', 'report']] loop
    begin
      update ai_assistant_config set ingest_sources = good where id = 1;
      outcome := 'accepted';
    exception when others then outcome := sqlerrm; end;
    perform pg_temp.ok('380: ' || array_to_string(good, ',') || ' accepted', outcome = 'accepted', outcome);
  end loop;
  begin
    update ai_assistant_config set ingest_sources = '{}' where id = 1;
    outcome := 'accepted';
  exception when others then outcome := sqlerrm; end;
  perform pg_temp.ok('380: an empty list is accepted (switches everything off)', outcome = 'accepted', outcome);

  -- an unrelated column update does not re-check (trigger is on ingest_sources only)
  perform pg_temp.ok('380: the trigger fires only on INSERT / UPDATE OF ingest_sources',
    (select pg_get_triggerdef(oid) from pg_trigger where tgname = 'ai_assistant_config_sources_check') ~ 'BEFORE INSERT OR UPDATE OF ingest_sources');

  -- null → the NOT NULL constraint, not the trigger
  begin
    update ai_assistant_config set ingest_sources = null where id = 1;
    outcome := 'accepted';
  exception when not_null_violation then outcome := 'refused'; end;
  perform pg_temp.ok('ingest_sources = null is refused (not null)', outcome = 'refused', outcome);

  -- ── 379's second net: the trigger bypassed (disabled), bad names got in anyway
  alter table ai_assistant_config disable trigger ai_assistant_config_sources_check;
  update ai_assistant_config set ingest_sources = '{tts_article,kb_articles}' where id = 1;
  begin v := ai_reconcile(500); outcome := 'ok ' || v::text;
  exception when others then outcome := 'RAISED ' || sqlerrm; end;
  perform pg_temp.ok('379 net: a typo that got in does not stop ai_reconcile() of the valid sources', outcome like 'ok%', left(outcome, 200));
  begin v := ai_backfill(null); outcome := 'ok ' || v::text;
  exception when others then outcome := 'RAISED ' || sqlerrm; end;
  perform pg_temp.ok('379 net: ... nor ai_backfill() of the valid sources', outcome like 'ok%', left(outcome, 200));
  begin v := ai_ingest_sweep('schedule'); outcome := 'ok ' || v::text;
  exception when others then outcome := 'RAISED ' || sqlerrm; end;
  perform pg_temp.ok('379 net: ... nor ai_ingest_sweep(); status swept, the typo reported in the run row',
    outcome like 'ok%' and v->>'status' = 'swept'
    and (select stats->'ignored_sources' from ai_ingest_runs where id = (v->>'run_id')::bigint) = '["kb_articles"]'::jsonb, left(outcome, 200));
  update ai_assistant_config set ingest_sources = '{tts_article,payroll,Salaries,qa_salary}' where id = 1;
  x := public.ai_source_types();
  perform pg_temp.ok('379 net: sensitive names that got in are dropped by ai_source_types() and listed by ai_ignored_sources()',
    x = '{tts_article}' and public.ai_ignored_sources() @> '{Salaries,payroll,qa_salary}' and public.ai_ignored_sources() <@ '{Salaries,payroll,qa_salary}',
    x::text || ' / ' || public.ai_ignored_sources()::text);
  perform pg_temp.ok('379 net: ai_ingest_stats().ignored_sources shows them',
    jsonb_array_length(public.ai_ingest_stats()->'ignored_sources') = 3
    and (public.ai_ingest_stats()->'ignored_sources') ?& array['Salaries', 'payroll', 'qa_salary'], (public.ai_ingest_stats()->'ignored_sources')::text);
  begin v := ai_reconcile(500); outcome := 'ok ' || v::text;
  exception when others then outcome := 'RAISED ' || sqlerrm; end;
  perform pg_temp.ok('379 net: a deny-listed name does not stop reconcile, and nothing is enqueued under it',
    outcome like 'ok%' and not (v ? 'payroll') and not exists (select 1 from ai_ingest_queue where source_type in ('payroll','Salaries','qa_salary')), left(outcome, 200));
  alter table ai_assistant_config enable trigger ai_assistant_config_sources_check;
  perform pg_temp.ok('the trigger is enabled again', (select tgenabled from pg_trigger where tgname = 'ai_assistant_config_sources_check') = 'O');

  -- duplicates harmless
  update ai_assistant_config set ingest_sources = '{report,report,incentive}' where id = 1;
  perform pg_temp.ok('duplicates in the setting: ai_source_types() still returns each type (dupes harmless)',
    public.ai_source_types() @> '{report,incentive}' and not public.ai_source_types() && '{kb_article}'::text[], public.ai_source_types()::text);
end $$;

select n, result, test, detail from xres order by n;
select case when count(*) filter (where result = 'FAIL') = 0 then 'SOURCES: PASS' else 'SOURCES: FAIL' end as verdict,
       count(*) filter (where result = 'ok') as ok, count(*) filter (where result = 'FAIL') as failed
  from xres;
