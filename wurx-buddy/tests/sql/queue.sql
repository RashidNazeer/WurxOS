-- ============================================================
-- Phase 1: ingestion-queue logic (mig 369, as changed by 372).
-- Run:  npm run sql:queue   (from Assistant/)
-- Always rolled back by the runner: nothing persists.
--
-- now() is frozen for the whole transaction, so "time passing" is simulated
-- by moving not_before / locked_at into the past.
-- All fixture rows use source_type 'qtest'. The WARNs of the phase-1 review
-- (M1, M3, L1, L2) are hard assertions since mig 372; see
-- qa/2026-09-28-phase1.md and qa/2026-09-28-fixround.md.
-- ============================================================

create temp table qres (n serial, test text, result text, detail text) on commit drop;
grant all on qres to authenticated, anon, service_role;
grant all on sequence qres_n_seq to authenticated, anon, service_role;

create function pg_temp.ok(t text, cond boolean, d text default null) returns void language sql as $$
  insert into qres (test, result, detail) values (t, case when cond then 'ok' else 'FAIL' end, d);
$$;
create function pg_temp.warn(t text, d text) returns void language sql as $$
  insert into qres (test, result, detail) values (t, 'WARN', d);
$$;
-- park every qtest row so the next section starts from an empty qtest queue
create function pg_temp.park() returns void language sql as $$
  update ai_ingest_queue set status = 'done', done_at = now() where source_type = 'qtest' and status in ('pending','processing');
$$;

-- precondition: claim() takes the whole queue, so foreign due rows would skew it
do $$ begin perform pg_temp.ok('precondition: no non-test rows are claimable on dev',
  not exists (select 1 from ai_ingest_queue where source_type <> 'qtest'
                 and (status = 'pending' or (status = 'processing' and locked_at < now() - interval '10 minutes')))); end $$;

-- ── 1. debounce + one pending row per source ────────────────────────
do $$
declare r ai_ingest_queue; c int;
begin
  perform ai_enqueue('qtest', 'a', 'upsert', 5::smallint, interval '0');
  update ai_ingest_queue set not_before = now() - interval '1 minute', enqueued_at = now() - interval '1 minute'
   where source_type = 'qtest' and source_id = 'a';
  perform ai_enqueue('qtest', 'a', 'upsert', 5::smallint, interval '180 seconds');
  select * into r from ai_ingest_queue where source_type = 'qtest' and source_id = 'a' and status = 'pending';
  perform pg_temp.ok('debounce: re-enqueue pushes not_before to now()+180s', r.not_before = now() + interval '180 seconds', r.not_before::text);
  perform pg_temp.ok('debounce: re-enqueue bumps enqueued_at', r.enqueued_at = now());

  perform ai_enqueue('qtest', 'a', 'upsert', 5::smallint, interval '10 seconds');
  select * into r from ai_ingest_queue where source_type = 'qtest' and source_id = 'a' and status = 'pending';
  perform pg_temp.ok('debounce: a shorter debounce never pulls not_before back', r.not_before = now() + interval '180 seconds', r.not_before::text);

  select count(*) into c from ai_ingest_queue where source_type = 'qtest' and source_id = 'a';
  perform pg_temp.ok('debounce: 3 enqueues -> exactly 1 row', c = 1, c::text);

  for i in 1..50 loop perform ai_enqueue('qtest', 'b', 'upsert', 5::smallint, interval '180 seconds'); end loop;
  select count(*) into c from ai_ingest_queue where source_type = 'qtest' and source_id = 'b' and status = 'pending';
  perform pg_temp.ok('debounce: 50 autosaves -> exactly 1 pending row', c = 1, c::text);

  -- L1 (mig 372): a delete merged into a debounced upsert is due now
  perform ai_enqueue('qtest', 'b', 'delete', 0, interval '0');
  select * into r from ai_ingest_queue where source_type = 'qtest' and source_id = 'b' and status = 'pending';
  perform pg_temp.ok('debounce: delete merged into a debounced upsert is due now (not_before = now())',
    r.op = 'delete' and r.priority = 0 and r.not_before = now(), row(r.op, r.priority, r.not_before - now())::text);

  -- a debounced upsert arriving after a pending delete does not push the delete back
  perform ai_enqueue('qtest', 'b', 'upsert', 5, interval '180 seconds');
  select * into r from ai_ingest_queue where source_type = 'qtest' and source_id = 'b' and status = 'pending';
  perform pg_temp.ok('debounce: an upsert after a pending delete keeps it delete and due now',
    r.op = 'delete' and r.not_before = now(), row(r.op, r.not_before - now())::text);

  -- a fresh delete (no pending row) is due now even when a debounce is passed
  perform ai_enqueue('qtest', 'b2', 'delete', 0, interval '180 seconds');
  select * into r from ai_ingest_queue where source_type = 'qtest' and source_id = 'b2' and status = 'pending';
  perform pg_temp.ok('debounce: a new delete ignores p_debounce', r.not_before = now(), (r.not_before - now())::text);
end $$;
do $$ begin perform pg_temp.park(); end $$;

-- ── 2. op precedence: delete > upsert > acl, every order ───────────
do $$
declare a text; b text; c text; got text; exp text; sid text;
begin
  foreach a in array array['upsert','delete','acl'] loop
    foreach b in array array['upsert','delete','acl'] loop
      sid := 'op-' || a || '-' || b;
      perform ai_enqueue('qtest', sid, a);
      perform ai_enqueue('qtest', sid, b);
      select op into got from ai_ingest_queue where source_type = 'qtest' and source_id = sid and status = 'pending';
      exp := case when 'delete' in (a, b) then 'delete' when 'upsert' in (a, b) then 'upsert' else 'acl' end;
      perform pg_temp.ok('precedence: ' || a || ' then ' || b || ' -> ' || exp, got = exp, got);
    end loop;
  end loop;
  -- all 6 orders of the three ops
  for a, b, c in select * from (values ('upsert','delete','acl'),('upsert','acl','delete'),('delete','upsert','acl'),
                                       ('delete','acl','upsert'),('acl','upsert','delete'),('acl','delete','upsert')) v loop
    sid := 'op3-' || a || '-' || b || '-' || c;
    perform ai_enqueue('qtest', sid, a); perform ai_enqueue('qtest', sid, b); perform ai_enqueue('qtest', sid, c);
    select op into got from ai_ingest_queue where source_type = 'qtest' and source_id = sid and status = 'pending';
    perform pg_temp.ok('precedence: ' || a || ', ' || b || ', ' || c || ' -> delete', got = 'delete', got);
  end loop;
  perform ai_enqueue('qtest', 'op-acl-acl-acl', 'acl'); perform ai_enqueue('qtest', 'op-acl-acl-acl', 'acl');
  perform ai_enqueue('qtest', 'op-acl-acl-acl', 'acl');
  select op into got from ai_ingest_queue where source_type = 'qtest' and source_id = 'op-acl-acl-acl' and status = 'pending';
  perform pg_temp.ok('precedence: acl x3 stays acl', got = 'acl', got);
end $$;
do $$ begin perform pg_temp.park(); end $$;

-- ── 3. priority keeps the minimum ───────────────────────────────────
do $$
declare p smallint;
begin
  perform ai_enqueue('qtest', 'prio', 'upsert', 7::smallint);
  perform ai_enqueue('qtest', 'prio', 'upsert', 2::smallint);
  perform ai_enqueue('qtest', 'prio', 'upsert', 9::smallint);
  select priority into p from ai_ingest_queue where source_type = 'qtest' and source_id = 'prio' and status = 'pending';
  perform pg_temp.ok('priority: 7, 2, 9 -> 2', p = 2, p::text);
  perform ai_enqueue('qtest', 'prio', 'upsert');   -- default 5
  select priority into p from ai_ingest_queue where source_type = 'qtest' and source_id = 'prio' and status = 'pending';
  perform pg_temp.ok('priority: default re-enqueue does not raise it', p = 2, p::text);
end $$;
do $$ begin perform pg_temp.park(); end $$;

-- ── 4. claim: not_before, priority order, no double claim, stale reclaim ──
do $$
declare ids text[]; r ai_ingest_queue;
begin
  perform ai_enqueue('qtest', 'c1', 'upsert', 5::smallint);                          -- due now
  perform ai_enqueue('qtest', 'c2', 'upsert', 1::smallint);                          -- due, most urgent
  perform ai_enqueue('qtest', 'c3', 'upsert', 0::smallint, interval '60 seconds');   -- urgent but NOT due
  perform ai_enqueue('qtest', 'c4', 'upsert', 5::smallint);
  update ai_ingest_queue set not_before = now() - interval '5 minutes'
   where source_type = 'qtest' and source_id = 'c4' and status = 'pending';          -- same priority as c1, older

  select array_agg(source_id order by source_id) into ids from ai_ingest_claim(2, 'w1');
  perform pg_temp.ok('claim(2): takes priority 1 then the older priority-5 row (c2, c4)', ids = array['c2','c4'], ids::text);

  select * into r from ai_ingest_queue where source_type = 'qtest' and source_id = 'c2' and status = 'processing';
  perform pg_temp.ok('claim: sets processing, locked_by, locked_at, attempts=1',
    r.locked_by = 'w1' and r.locked_at = now() and r.attempts = 1, row(r.status, r.locked_by, r.attempts)::text);

  select array_agg(source_id order by source_id) into ids from ai_ingest_claim(10, 'w2');
  perform pg_temp.ok('claim again: only c1 (never c2/c4 again, never not-yet-due c3)', ids = array['c1'], coalesce(ids::text, 'none'));

  select array_agg(source_id) into ids from ai_ingest_claim(10, 'w3');
  perform pg_temp.ok('claim a third time: nothing', ids is null, coalesce(ids::text, 'none'));

  -- c2's worker died 11 minutes ago; c4's worker is only 9 minutes in
  update ai_ingest_queue set locked_at = now() - interval '11 minutes' where source_type = 'qtest' and source_id = 'c2' and status = 'processing';
  update ai_ingest_queue set locked_at = now() - interval '9 minutes'  where source_type = 'qtest' and source_id = 'c4' and status = 'processing';
  select array_agg(source_id) into ids from ai_ingest_claim(10, 'w4');
  perform pg_temp.ok('claim: reclaims processing row locked > 10 min, not one locked 9 min', ids = array['c2'], coalesce(ids::text, 'none'));
  select * into r from ai_ingest_queue where source_type = 'qtest' and source_id = 'c2' and status = 'processing';
  perform pg_temp.ok('reclaim: new owner w4, attempts=2', r.locked_by = 'w4' and r.attempts = 2, row(r.locked_by, r.attempts)::text);

  -- L2 (mig 372): the dead worker w1 wakes up and tries to close c2 while w4 holds it
  perform pg_temp.ok('complete by a stale worker returns false', ai_ingest_complete(r.id, 'w1') = false);
  perform pg_temp.ok('fail by a stale worker returns false', ai_ingest_fail(r.id, 'w1', 'stale') = false);
  select * into r from ai_ingest_queue where id = r.id;
  perform pg_temp.ok('stale complete/fail: row stays processing, owned by w4, no error written',
    r.status = 'processing' and r.locked_by = 'w4' and r.last_error is null, row(r.status, r.locked_by, r.last_error)::text);

  -- M1 (mig 372): a row stuck in processing after its 5th attempt is parked as failed by claim
  update ai_ingest_queue set locked_at = now() - interval '11 minutes', attempts = 5
   where source_type = 'qtest' and source_id = 'c4' and status = 'processing';
  -- and one stuck after its 4th attempt is still reclaimed (attempt 5)
  update ai_ingest_queue set locked_at = now() - interval '11 minutes', attempts = 4
   where source_type = 'qtest' and source_id = 'c1' and status = 'processing';
  select array_agg(source_id order by source_id) into ids from ai_ingest_claim(10, 'w5');
  perform pg_temp.ok('claim: stuck row with attempts>=5 is not reclaimed; attempts=4 is', ids = array['c1'], coalesce(ids::text, 'none'));
  select * into r from ai_ingest_queue where source_type = 'qtest' and source_id = 'c4' order by id desc limit 1;
  perform pg_temp.ok('claim: stuck row with attempts>=5 becomes failed with the crash error, unlocked',
    r.status = 'failed' and r.last_error = 'worker crashed or timed out 5 times' and r.locked_at is null and r.attempts = 5,
    row(r.status, r.last_error, r.locked_at, r.attempts)::text);
  select * into r from ai_ingest_queue where source_type = 'qtest' and source_id = 'c1' and status = 'processing';
  perform pg_temp.ok('reclaim of c1: owner w5, attempts=5', r.locked_by = 'w5' and r.attempts = 5, row(r.locked_by, r.attempts)::text);
  -- a stuck row with attempts>=5 whose lock is still fresh is left alone
  update ai_ingest_queue set locked_at = now() - interval '9 minutes' where id = r.id;
  perform ai_ingest_claim(10, 'w6');
  perform pg_temp.ok('claim: a fresh lock at attempts=5 is not parked', (select status from ai_ingest_queue where id = r.id) = 'processing');

  -- p_limit is clamped to at least 1
  perform pg_temp.park();
  perform ai_enqueue('qtest', 'l1', 'upsert'); perform ai_enqueue('qtest', 'l2', 'upsert');
  select array_agg(source_id) into ids from ai_ingest_claim(0, 'w6');
  perform pg_temp.ok('claim(0): clamps to 1 row', cardinality(ids) = 1, coalesce(ids::text, 'none'));
end $$;
do $$ begin perform pg_temp.park(); end $$;

-- ── 5. complete ─────────────────────────────────────────────────────
do $$
declare r ai_ingest_queue;
begin
  perform ai_enqueue('qtest', 'done1', 'upsert');
  select * into r from ai_ingest_claim(1, 'w1');
  perform pg_temp.ok('fail by the owner returns true', ai_ingest_fail(r.id, 'w1', 'first error'));
  update ai_ingest_queue set not_before = now() where id = r.id;
  select * into r from ai_ingest_claim(1, 'w1');
  perform pg_temp.ok('complete by the owner returns true', ai_ingest_complete(r.id, 'w1'));
  select * into r from ai_ingest_queue where id = r.id;
  perform pg_temp.ok('complete: done, done_at set, lock and last_error cleared',
    r.status = 'done' and r.done_at = now() and r.locked_at is null and r.last_error is null, row(r.status, r.locked_at, r.last_error)::text);

  -- L2: closing an already-done row again is a no-op, and a late fail cannot resurrect it
  perform pg_temp.ok('complete on a done row returns false', ai_ingest_complete(r.id, 'w1') = false);
  perform pg_temp.ok('fail on a done row returns false', ai_ingest_fail(r.id, 'w1', 'late') = false);
  perform pg_temp.ok('done row stays done after late complete/fail',
    (select status = 'done' and last_error is null from ai_ingest_queue where id = r.id));
  perform pg_temp.ok('complete with a null worker returns false', ai_ingest_complete(r.id, null) = false);

  -- a pending row (never claimed) cannot be completed
  perform ai_enqueue('qtest', 'done2', 'upsert', 5, interval '60 seconds');
  select * into r from ai_ingest_queue where source_type = 'qtest' and source_id = 'done2' and status = 'pending';
  perform pg_temp.ok('complete on a pending row returns false and leaves it pending',
    ai_ingest_complete(r.id, 'w1') = false and (select status from ai_ingest_queue where id = r.id) = 'pending');
end $$;
do $$ begin perform pg_temp.park(); end $$;

-- ── 6. fail: backoff by attempt, 'failed' after the 5th ─────────────
do $$
declare r ai_ingest_queue; i int; expected interval[] := array[interval '1 minute', interval '5 minutes', interval '30 minutes', interval '2 hours'];
begin
  perform ai_enqueue('qtest', 'f1', 'upsert');
  for i in 1..5 loop
    select * into r from ai_ingest_claim(1, 'w1');
    if r.id is null or r.attempts <> i then
      perform pg_temp.ok('fail: claim #' || i || ' returns f1 with attempts=' || i, false, row(r.source_id, r.attempts)::text);
      exit;
    end if;
    perform ai_ingest_fail(r.id, 'w1', 'boom ' || i);
    select * into r from ai_ingest_queue where id = r.id;
    if i < 5 then
      perform pg_temp.ok('fail #' || i || ': pending, not_before = now()+' || expected[i] || ', unlocked',
        r.status = 'pending' and r.not_before = now() + expected[i] and r.locked_at is null and r.last_error = 'boom ' || i,
        row(r.status, r.not_before - now(), r.locked_at, r.last_error)::text);
      update ai_ingest_queue set not_before = now() where id = r.id;   -- time passes
    else
      perform pg_temp.ok('fail #5: status failed', r.status = 'failed', r.status);
    end if;
  end loop;
  select * into r from ai_ingest_claim(10, 'w1');
  perform pg_temp.ok('fail: a failed row is never claimed again', r.id is null, coalesce(r.source_id, 'none'));

  perform ai_enqueue('qtest', 'f2', 'upsert');
  select * into r from ai_ingest_claim(1, 'w1');
  perform ai_ingest_fail(r.id, 'w1', repeat('x', 5000));
  select * into r from ai_ingest_queue where id = r.id;
  perform pg_temp.ok('fail: last_error truncated to 1000 chars', length(r.last_error) = 1000, length(r.last_error)::text);

  perform pg_temp.ok('fail: unknown id returns false (no error)', ai_ingest_fail(-1, 'w1', 'no such row') = false);
  perform pg_temp.ok('complete: unknown id returns false (no error)', ai_ingest_complete(-1, 'w1') = false);
end $$;
do $$ begin perform pg_temp.park(); end $$;

-- ── 7. newer pending row: failing row is closed, not requeued ───────
-- ── 8. re-enqueue while processing creates a new pending row ────────
do $$
declare r ai_ingest_queue; c_pending int; c_all int; newer ai_ingest_queue;
begin
  perform ai_enqueue('qtest', 'n1', 'upsert');
  select * into r from ai_ingest_claim(1, 'w1');
  perform ai_enqueue('qtest', 'n1', 'delete', 1);
  select count(*) filter (where status = 'pending'), count(*) into c_pending, c_all
    from ai_ingest_queue where source_type = 'qtest' and source_id = 'n1';
  perform pg_temp.ok('re-enqueue while processing: new pending row (2 rows, 1 pending)', c_all = 2 and c_pending = 1, c_all || '/' || c_pending);
  select * into newer from ai_ingest_queue where source_type = 'qtest' and source_id = 'n1' and status = 'pending';
  perform pg_temp.ok('re-enqueue while processing: the new row carries the new intent', newer.op = 'delete' and newer.priority = 1, row(newer.op, newer.priority)::text);

  perform ai_ingest_fail(r.id, 'w1', 'worker saw a stale row');
  select * into r from ai_ingest_queue where id = r.id;
  perform pg_temp.ok('fail with newer pending: failing row closed as done, error kept',
    r.status = 'done' and r.last_error = 'worker saw a stale row', row(r.status, r.last_error)::text);
  select count(*) into c_pending from ai_ingest_queue where source_type = 'qtest' and source_id = 'n1' and status = 'pending';
  perform pg_temp.ok('fail with newer pending: still exactly 1 pending row (no unique violation)', c_pending = 1, c_pending::text);
end $$;
do $$ begin perform pg_temp.park(); end $$;

-- ── 9. ai_ingest_retry: admin only ──────────────────────────────────
do $$ begin
  perform set_config('t.boss', (select id::text from profiles where role = 'boss' and is_active and deleted_at is null limit 1), true);
  perform set_config('t.apc',  (select id::text from profiles where role = 'apc'  and is_active and deleted_at is null limit 1), true);
  perform set_config('t.dev',  (select id::text from profiles where role = 'developer' and is_active and deleted_at is null limit 1), true);
end $$;

do $$
declare r ai_ingest_queue; fid bigint; outcome text; who record;
begin
  perform ai_enqueue('qtest', 'r1', 'acl', 6::smallint);
  select * into r from ai_ingest_claim(1, 'w1');
  update ai_ingest_queue set attempts = 5 where id = r.id;
  perform ai_ingest_fail(r.id, 'w1', 'gave up');
  fid := r.id;
  perform pg_temp.ok('retry fixture: row is failed', (select status from ai_ingest_queue where id = fid) = 'failed');

  for who in select * from (values ('apc', current_setting('t.apc')), ('developer', current_setting('t.dev'))) v(label, uid) loop
    perform set_config('request.jwt.claims', json_build_object('sub', who.uid, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    begin
      perform ai_ingest_retry(fid);
      outcome := 'allowed';
    exception when others then outcome := sqlerrm;
    end;
    execute 'reset role';
    perform pg_temp.ok('retry: refused for ' || who.label, outcome = 'not allowed', outcome);
  end loop;
  perform pg_temp.ok('retry: refused calls left the row failed', (select status from ai_ingest_queue where id = fid) = 'failed');

  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  execute 'set local role anon';
  begin perform ai_ingest_retry(fid); outcome := 'allowed';
  exception when insufficient_privilege then outcome := 'permission denied'; when others then outcome := sqlerrm; end;
  execute 'reset role';
  perform pg_temp.ok('retry: anon has no execute', outcome = 'permission denied', outcome);

  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('t.boss'), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin perform ai_ingest_retry(fid); outcome := 'allowed';
  exception when others then outcome := sqlerrm; end;
  execute 'reset role';
  perform pg_temp.ok('retry: boss allowed', outcome = 'allowed', outcome);
  perform pg_temp.ok('retry: failed row closed as done', (select status from ai_ingest_queue where id = fid) = 'done');
  select * into r from ai_ingest_queue where source_type = 'qtest' and source_id = 'r1' and status = 'pending';
  perform pg_temp.ok('retry: new pending row, same op, priority 1, reason manual, attempts 0',
    r.op = 'acl' and r.priority = 1 and r.reason = 'manual' and r.attempts = 0, row(r.op, r.priority, r.reason, r.attempts)::text);
end $$;
do $$ begin perform set_config('request.jwt.claims', '', true); end $$;
do $$ begin perform pg_temp.park(); end $$;

-- ── 10. ai_enqueue swallows errors ──────────────────────────────────
do $$
declare outcome text; c int;
begin
  begin perform ai_enqueue(null, 'sw1', 'upsert'); outcome := 'swallowed';
  exception when others then outcome := 'RAISED: ' || sqlerrm; end;
  perform pg_temp.ok('enqueue: null source_type does not raise', outcome = 'swallowed', outcome);

  begin perform ai_enqueue('qtest', null, 'upsert'); outcome := 'swallowed';
  exception when others then outcome := 'RAISED: ' || sqlerrm; end;
  perform pg_temp.ok('enqueue: null source_id does not raise', outcome = 'swallowed', outcome);

  begin perform ai_enqueue('qtest', 'sw3', 'bogus'); outcome := 'swallowed';
  exception when others then outcome := 'RAISED: ' || sqlerrm; end;
  perform pg_temp.ok('enqueue: invalid op does not raise', outcome = 'swallowed', outcome);

  begin perform ai_enqueue('qtest', 'sw4', 'upsert', null::smallint); outcome := 'swallowed';
  exception when others then outcome := 'RAISED: ' || sqlerrm; end;
  perform pg_temp.ok('enqueue: null priority does not raise', outcome = 'swallowed', outcome);

  select count(*) into c from ai_ingest_queue where source_type = 'qtest' and source_id in ('sw3','sw4')
     or (source_type is null) or (source_type = 'qtest' and source_id is null);
  perform pg_temp.ok('enqueue: failed enqueues left no rows', c = 0, c::text);

  perform ai_enqueue('qtest', 'sw5', 'upsert');
  perform pg_temp.ok('enqueue: the transaction is still usable after a swallowed error',
    exists (select 1 from ai_ingest_queue where source_type = 'qtest' and source_id = 'sw5'));

  -- M3 (mig 372): trigger authors can pass a plain int literal priority
  begin perform ai_enqueue('qtest', 'sw6', 'upsert', 5); outcome := 'resolved';
  exception when undefined_function then outcome := 'function does not exist';
  end;
  perform pg_temp.ok('enqueue: ai_enqueue(..., 5) with an int literal resolves', outcome = 'resolved', outcome);
  perform pg_temp.ok('enqueue: the int-literal call stored priority 5',
    (select priority from ai_ingest_queue where source_type = 'qtest' and source_id = 'sw6' and status = 'pending') = 5);

  -- an out-of-range int priority overflows the smallint cast inside the function: swallowed, no row
  begin perform ai_enqueue('qtest', 'sw7', 'upsert', 70000); outcome := 'swallowed';
  exception when others then outcome := 'RAISED: ' || sqlerrm; end;
  perform pg_temp.ok('enqueue: out-of-range priority 70000 is swallowed, no row',
    outcome = 'swallowed' and not exists (select 1 from ai_ingest_queue where source_type = 'qtest' and source_id = 'sw7'), outcome);

  perform pg_temp.ok('enqueue: exactly one ai_enqueue overload (the old smallint one is gone)',
    (select count(*) from pg_proc where proname = 'ai_enqueue' and pronamespace = 'public'::regnamespace) = 1);
end $$;

-- ── results ─────────────────────────────────────────────────────────
select n, result, test, detail from qres order by n;
select case when count(*) filter (where result = 'FAIL') = 0 then 'QUEUE: PASS' else 'QUEUE: FAIL' end as verdict,
       count(*) filter (where result = 'ok')   as ok,
       count(*) filter (where result = 'FAIL') as failed,
       count(*) filter (where result = 'WARN') as warnings
  from qres;
