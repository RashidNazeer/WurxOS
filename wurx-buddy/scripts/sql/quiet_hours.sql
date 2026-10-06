-- ============================================================
-- Mig 407: ingestion rests 18:00–02:00 Asia/Karachi.
-- Run:  node scripts/db-dev.mjs sql scripts/sql/quiet_hours.sql   (always rolled back)
-- The clock is moved by setting the window around "now" instead of faking time.
-- ============================================================

create temp table qres (n serial, test text, result text, detail text) on commit drop;
grant all on qres to authenticated; grant all on sequence qres_n_seq to authenticated;
create function pg_temp.ok(t text, c boolean, d text default null) returns void language sql as $$
  insert into qres (test, result, detail) values (t, case when c then 'ok' else 'FAIL' end, d) $$;
create function pg_temp.try(sql text) returns text language plpgsql as $$
declare n int; begin execute sql; get diagnostics n = row_count; return 'rows=' || n;
exception when insufficient_privilege then return 'denied'; when others then return 'error: ' || sqlerrm; end $$;
create function pg_temp.val(sql text) returns text language plpgsql as $$
declare v text; begin execute sql into v; return coalesce(v, 'null');
exception when insufficient_privilege then return 'denied'; when others then return 'error: ' || sqlerrm; end $$;
grant execute on function pg_temp.ok(text, boolean, text), pg_temp.try(text), pg_temp.val(text) to authenticated;

-- Put the window around the current Pakistan time: `quiet` covers now, `open` does not.
create function pg_temp.window_quiet() returns void language sql as $$
  update public.ai_assistant_config
     set ingest_quiet_enabled = true,
         ingest_quiet_start = ((now() at time zone 'Asia/Karachi') - interval '1 hour')::time,
         ingest_quiet_end   = ((now() at time zone 'Asia/Karachi') + interval '3 hours')::time
   where id = 1 $$;
create function pg_temp.window_open() returns void language sql as $$
  update public.ai_assistant_config
     set ingest_quiet_enabled = true,
         ingest_quiet_start = ((now() at time zone 'Asia/Karachi') + interval '2 hours')::time,
         ingest_quiet_end   = ((now() at time zone 'Asia/Karachi') + interval '6 hours')::time
   where id = 1 $$;

do $$
declare v_defaults text; v_next timestamptz; v_local time;
begin
  -- defaults shipped by the migration
  select format('%s/%s/%s', ingest_quiet_enabled, to_char(ingest_quiet_start, 'HH24:MI'), to_char(ingest_quiet_end, 'HH24:MI'))
    into v_defaults from public.ai_assistant_config where id = 1;
  perform pg_temp.ok('dev: quiet hours on, 18:00-02:00 Pakistan time', v_defaults = 't/18:00/02:00', v_defaults);

  -- the real window wraps midnight: 19:00 and 01:00 are quiet, 03:00 and 17:00 are not
  perform pg_temp.ok('the shipped window wraps midnight (19:00 and 01:00 quiet; 03:00 and 17:00 open)',
    (select bool_and(q = expect) from (values
       ('19:00'::time, true), ('01:00'::time, true), ('23:59'::time, true), ('18:00'::time, true),
       ('02:00'::time, false), ('03:00'::time, false), ('17:59'::time, false)) v(t, expect)
     cross join lateral (select case when t >= '18:00'::time or t < '02:00'::time then true else false end as q) x));

  -- inside the window
  perform pg_temp.window_quiet();
  perform pg_temp.ok('inside the window: quiet now', public.ai_ingest_quiet_now());
  v_next := public.ai_ingest_next_allowed_at();
  v_local := (v_next at time zone 'Asia/Karachi')::time;
  perform pg_temp.ok('next_allowed_at is in the future and lands on the window end',
    v_next > now() and v_next < now() + interval '25 hours'
      and v_local = (select ingest_quiet_end from public.ai_assistant_config where id = 1),
    v_next::text);
  perform pg_temp.ok('the automatic sweep does nothing: status quiet_hours + next_allowed_at',
    (public.ai_ingest_sweep_if_due()->>'status') = 'quiet_hours' and (public.ai_ingest_sweep_if_due() ? 'next_allowed_at'),
    public.ai_ingest_sweep_if_due()::text);
  perform pg_temp.ok('no queue items are claimed', (select count(*) from public.ai_ingest_claim(50, 'quiet-test')) = 0);
  -- mig 408 gates the backfill through ai_vector_backfill_allowed(), which finds this window by name.
  perform pg_temp.ok('the vector backfill is not allowed, and its work list is empty',
    not public.ai_vector_backfill_allowed() and public.ai_vector_pending('primary', 10) = '[]'::jsonb);
  perform pg_temp.ok('the crawl refuses to start: quiet_hours', (public.ai_crawl_start()->>'status') = 'quiet_hours',
    public.ai_crawl_start()::text);
  -- the 12 h clock is NOT reset by a skipped sweep
  perform pg_temp.ok('a skipped sweep writes no run row (the 12 h clock is untouched)',
    (select count(*) from public.ai_ingest_runs where started_at > now() - interval '1 minute') = 0);
  -- a batch already claimed still finishes
  perform pg_temp.ok('the apply side still works while quiet (claimed items finish, nothing is left processing)',
    public.ai_ingest_touch('kb_article', 'quiet-hours-no-such-doc', 'fp') is not null
      and (public.ai_vector_fill('primary', public.ai_embed_model(), '[]'::jsonb)) = 0);

  -- outside the window
  perform pg_temp.window_open();
  perform pg_temp.ok('outside the window: not quiet', not public.ai_ingest_quiet_now());
  perform pg_temp.ok('outside the window: next_allowed_at is now', public.ai_ingest_next_allowed_at() <= now() + interval '1 second');
  perform pg_temp.ok('outside the window: the sweep is considered (not quiet_hours)',
    (public.ai_ingest_sweep_if_due()->>'status') <> 'quiet_hours', public.ai_ingest_sweep_if_due()->>'status');
  perform pg_temp.ok('outside the window: the backfill is allowed again',
    public.ai_vector_backfill_allowed() and jsonb_typeof(public.ai_vector_pending('primary', 5)) = 'array');

  -- switched off entirely
  update public.ai_assistant_config set ingest_quiet_enabled = false where id = 1;
  perform pg_temp.window_quiet();
  update public.ai_assistant_config set ingest_quiet_enabled = false where id = 1;
  perform pg_temp.ok('switched off: never quiet even inside the window', not public.ai_ingest_quiet_now());

  -- validation
  perform pg_temp.ok('start = end is refused',
    pg_temp.try($q$update public.ai_assistant_config set ingest_quiet_start = '18:00', ingest_quiet_end = '18:00' where id = 1$q$) like 'error:%cannot be the same%');
  perform pg_temp.ok('a valid window is accepted',
    pg_temp.try($q$update public.ai_assistant_config set ingest_quiet_enabled = true, ingest_quiet_start = '20:00', ingest_quiet_end = '03:30' where id = 1$q$) = 'rows=1');
end $$;

-- ── "Run ingestion now": the Boss / a developer, force, and others refused ──
do $$
declare r text; who text; uid text;
begin
  perform pg_temp.window_quiet();
  foreach who in array array['boss', 'developer'] loop
    uid := (select id::text from public.profiles where role = who and is_active and deleted_at is null order by id limit 1);
    perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    r := pg_temp.val($q$select public.ai_run_ingestion()->>'status'$q$);
    perform pg_temp.ok(who || ': "Run now" is refused while quiet (status quiet_hours)', r = 'quiet_hours', r);
    r := pg_temp.val($q$select public.ai_run_ingestion()->>'message'$q$);
    perform pg_temp.ok(who || ': the refusal says when it can run again', r like '%Pakistan time%' and r like '%after%', r);
    r := pg_temp.val($q$select public.ai_run_ingestion(true)->>'status'$q$);
    perform pg_temp.ok(who || ': force overrides quiet hours (no quiet_hours status)', r <> 'quiet_hours', r);
    execute 'reset role';
  end loop;
  uid := (select id::text from public.profiles where role = 'apc' and is_active and deleted_at is null order by id limit 1);
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  r := pg_temp.val($q$select public.ai_run_ingestion()->>'status'$q$);
  -- ai_run_ingestion raises with errcode 42501, which pg_temp.val reports as 'denied'.
  perform pg_temp.ok('an APC is refused, forced or not', r = 'denied', r);
  r := pg_temp.val($q$select public.ai_run_ingestion(true)->>'status'$q$);
  perform pg_temp.ok('an APC cannot force either', r = 'denied', r);
  -- (ai_ingest_stats also lets a direct postgres session in, which this runner is,
  -- so the APC side of that gate is covered by scripts/sql/providers.sql instead.)
  execute 'reset role';
end $$;

-- ── the stats shape the settings screen reads ────────────────────────────
do $$
declare q jsonb; uid text;
begin
  perform pg_temp.window_quiet();
  uid := (select id::text from public.profiles where role = 'developer' and is_active and deleted_at is null order by id limit 1);
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  q := public.ai_ingest_stats()->'quiet_hours';
  execute 'reset role';
  perform pg_temp.ok('ai_ingest_stats.quiet_hours has every key, readable by a developer',
    q ?& array['enabled', 'start', 'end', 'tz', 'active_now', 'next_allowed_at']
      and (q->>'tz') = 'Asia/Karachi' and (q->>'active_now')::boolean, q::text);
end $$;

select n, test, result, detail from qres order by n;
select case when count(*) filter (where result = 'FAIL') = 0 then 'QUIET HOURS: PASS' else 'QUIET HOURS: FAIL' end verdict,
       count(*) filter (where result = 'ok') ok, count(*) filter (where result = 'FAIL') failed from qres;
