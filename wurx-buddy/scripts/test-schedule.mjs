// ============================================================
// Migrations 379 (sweep, on-demand run, M1), 380 (M1-b, exclusions), 375 (cron) and 374 (KB security
// trigger) test: executes them INSIDE one transaction, exercises them with
// SYNTHETIC rows only ("QA Zq …", period 2099), and ALWAYS rolls back. DEV ONLY.
// The vector store is live: real ai_documents are only read, never written.
//
//   node --experimental-strip-types scripts/test-schedule.mjs
//
// now() is frozen inside one transaction, so time is moved by backdating
// ai_ingest_runs.started_at. The worker runs with a fake embedder (no API calls).
// Requires an idle dev queue (nothing pending / processing).
// ============================================================
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { ASSISTANT, devDbUrl, SSL, stripBom } from './dev-env.mjs';
import { DEFAULT_CONFIG } from '../supabase/functions/_shared/ai/config.ts';
import { pgRpc } from '../supabase/functions/_shared/ai/ingest/db.ts';
import { runWorker } from '../supabase/functions/_shared/ai/ingest/worker.ts';

const results = [];
const check = (name, ok, detail = '') => { results.push({ ok: !!ok, name, detail: String(detail).slice(0, 200) }); };
const mig = (n) => stripBom(fs.readFileSync(path.join(ASSISTANT, 'supabase/migrations', fs.readdirSync(path.join(ASSISTANT, 'supabase/migrations')).find((f) => f.startsWith(`${n}_`))), 'utf8'));
const J = JSON.stringify;
const TESTING_DOC = '833b9bda-8282-41dc-a8da-8ff3f032354d';   // excluded by mig 380

function fakeVec(text) {
  const h = crypto.createHash('sha256').update(text).digest();
  let s = h.readUInt32LE(0) || 1;
  const v = new Array(DEFAULT_CONFIG.EMBED_DIMS);
  let n = 0;
  for (let i = 0; i < v.length; i++) { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; v[i] = s / 4294967296 - 0.5; n += v[i] * v[i]; }
  n = Math.sqrt(n);
  return v.map((x) => Math.round((x / n) * 1e6) / 1e6);
}
const fakeEmbed = async (texts) => ({ vectors: texts.map(fakeVec), tokens: 0, requests: 1 });

const c = new pg.Client({ connectionString: devDbUrl(), ssl: SSL, connectionTimeoutMillis: 20_000, query_timeout: 180_000 });
c.on('error', () => {});
await c.connect();
const q = async (sql, params) => (await c.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
const rpc = pgRpc(c, { savepoints: true });

let xid = null;
try {
  // L6: if this process dies mid-run, the server ends the session (and its locks).
  await c.query(`set idle_in_transaction_session_timeout = '60s'`);
  await c.query('begin');
  xid = (await one('select pg_current_xact_id()::text as x')).x;
  await c.query(`set local lock_timeout = '10s'`);
  const busy = await one(`select count(*)::int n from public.ai_ingest_queue where status in ('pending','processing')`);
  if (busy.n) throw new Error(`dev queue has ${busy.n} pending/processing rows; refusing`);
  const docs0 = await one(`select count(*)::int n, md5(string_agg(id::text || doc_hash || status, ',' order by id)) h from public.ai_documents
      where not (source_type = 'kb_article' and source_id = $1)`, [TESTING_DOC]);

  await c.query(mig(379));
  await c.query(mig(380));
  await c.query(mig(375));
  check('379 + 380 + 375 execute inside the transaction', true);

  // ---------------------------------------------------------- 375: jobs, config, tick
  // Only 375's jobs (381 adds the ai-tts-crawl-* pair; scripts/test-380.mjs covers those).
  const INGEST_JOBS = `('ai-ingest-tick','ai-ingest-sweep','ai-housekeeping','ai-reconcile')`;
  const jobs = Object.fromEntries((await q(`select jobname, schedule, command from cron.job where jobname in ${INGEST_JOBS}`)).map((j) => [j.jobname, j]));
  check('375: ai-ingest-tick every minute → ai_ingest_tick()', jobs['ai-ingest-tick']?.schedule === '* * * * *' && /ai_ingest_tick\(\)/.test(jobs['ai-ingest-tick'].command), J(jobs['ai-ingest-tick']));
  check('375: ai-ingest-sweep hourly at :05 → ai_ingest_sweep_if_due()', jobs['ai-ingest-sweep']?.schedule === '5 * * * *' && /ai_ingest_sweep_if_due\(\)/.test(jobs['ai-ingest-sweep'].command), J(jobs['ai-ingest-sweep']));
  check('375: ai-housekeeping nightly 22:30 GMT (03:30 PKT)', jobs['ai-housekeeping']?.schedule === '30 22 * * *', J(jobs['ai-housekeeping']));
  check('375: no separate ai-reconcile job (reconcile is part of the sweep); exactly 3 ai-* jobs', !jobs['ai-reconcile'] && Object.keys(jobs).length === 3, Object.keys(jobs).join(','));
  const cfg = await q(`select key, value from public.app_config where key in ('ai_ingest_url','ai_ingest_secret') order by key`);
  check('375: app_config ai_ingest_url / ai_ingest_secret exist (empty unless set before)', cfg.length === 2, cfg.map((r) => `${r.key}:${r.value ? 'set' : 'empty'}`).join(','));
  await c.query(mig(375));
  check('375 re-runs cleanly (idempotent), still 3 jobs', (await one(`select count(*)::int n from cron.job where jobname in ${INGEST_JOBS}`)).n === 3);

  const posts = async () => (await one(`select count(*)::int n from net.http_request_queue`)).n;
  await q(`update public.app_config set value = '' where key = 'ai_ingest_url'`);
  await q(`select public.ai_enqueue('qa_test', 'qa-tick', 'upsert', 5)`);
  const p0 = await posts();
  await q('select public.ai_ingest_tick()');
  check('tick: work waiting but no URL configured → no request', (await posts()) === p0);
  await q(`update public.app_config set value = 'https://qa.invalid/functions/v1/ai-ingest' where key = 'ai_ingest_url'`);
  await q(`update public.app_config set value = 'qa-not-a-secret' where key = 'ai_ingest_secret'`);
  await q('select public.ai_ingest_tick()');
  const post = await one(`select url, convert_from(body, 'utf8') body from net.http_request_queue order by id desc limit 1`);
  check('tick: due work + URL → exactly one POST {mode:drain} (queued in this transaction, never sent)', (await posts()) === p0 + 1 && post?.body?.includes('"drain"'), J(post));
  await q(`delete from public.ai_ingest_queue where source_type = 'qa_test'`);
  const p1 = await posts();
  for (let i = 0; i < 3; i++) await q('select public.ai_ingest_tick()');
  check('tick: empty queue → no-op (3 ticks, 0 requests)', (await posts()) === p1);
  await q(`select public.ai_enqueue('qa_test', 'qa-later', 'upsert', 5, interval '10 minutes')`);
  await q('select public.ai_ingest_tick()');
  check('tick: only not-yet-due work → no-op', (await posts()) === p1);
  await q(`delete from public.ai_ingest_queue where source_type = 'qa_test'`);

  // ---------------------------------------------------------- people
  const person = async (role, active = true) => (await one(`select id from public.profiles where role = $1 and is_active = $2 and deleted_at is null order by id limit 1`, [role, active]))?.id;
  const P = {};
  for (const r of ['boss', 'developer', 'apc', 'tl', 'ol', 'ipc', 'pctl', 'ads_manager']) P[r] = await person(r);
  for (const [k, v] of Object.entries(P)) if (!v) throw new Error(`no active ${k} on dev`);
  const brand = (await one(`select id from public.brands where status = 'active' order by id limit 1`)).id;

  // Runs one statement as `uid` (authenticated) and undoes everything it did.
  const asUser = async (uid, sql, params = [], role = 'authenticated') => {
    await c.query('savepoint u');
    let res = null, err = null;
    try {
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [J(uid ? { sub: uid, role } : { role })]);
      await c.query(`set local role ${role}`);
      res = await c.query(sql, params);
    } catch (e) { err = e; }
    await c.query('rollback to savepoint u');
    return { rows: res?.rows ?? [], n: res?.rowCount ?? -1, err: err?.message ?? '', code: err?.code ?? '' };
  };
  const RUN = 'select public.ai_run_ingestion() v';

  // ---------------------------------------------------------- who may run ingestion
  for (const r of ['boss', 'developer']) {
    const x = await asUser(P[r], RUN);
    check(`ai_run_ingestion: an active ${r} may run it → swept, triggered_by = them, trigger manual`,
      x.rows[0]?.v?.status === 'swept' && !x.err, x.err || J(x.rows[0]?.v));
  }
  {
    await c.query('savepoint inactive');
    await q(`update public.profiles set is_active = false where id = $1`, [P.developer]);
    const x = await asUser(P.developer, RUN);
    await c.query('rollback to savepoint inactive');
    check('ai_run_ingestion: an INACTIVE developer is refused', /not allowed/.test(x.err) && x.code === '42501', x.err || J(x.rows));
  }
  for (const r of ['apc', 'tl', 'ol', 'ipc', 'pctl', 'ads_manager']) {
    const x = await asUser(P[r], RUN);
    check(`ai_run_ingestion: ${r} is refused`, /not allowed/.test(x.err), x.err || J(x.rows));
  }
  const anon = await asUser(null, RUN, [], 'anon');
  check('ai_run_ingestion: anon has no EXECUTE', /permission denied/.test(anon.err), anon.err);
  for (const fn of ['ai_ingest_sweep()', 'ai_ingest_sweep_if_due()', 'ai_ingest_tick()', 'ai_housekeeping()', 'ai_last_sweep_at()']) {
    const x = await asUser(P.boss, `select public.${fn}`);
    check(`service only: even the Boss cannot call ${fn}`, /permission denied/.test(x.err), x.err);
  }
  const devCfg = await asUser(P.developer, `update public.ai_assistant_config set ingest_sources = '{}'`);
  const devPersona = await asUser(P.developer, `update public.ai_assistant_config set persona = persona || ' qa'`);
  const bossCfg = await asUser(P.boss, `update public.ai_assistant_config set ingest_sources = ingest_sources`);
  check('a developer who can run ingestion still cannot change ai_assistant_config (0 rows); the Boss can (1)',
    devCfg.n <= 0 && devPersona.n <= 0 && bossCfg.n === 1, `dev ${devCfg.n}/${devPersona.n}, boss ${bossCfg.n}`);
  check('no developer path to the setting: ai_set_source_enabled still does not exist',
    !(await one(`select exists (select 1 from pg_proc where proname = 'ai_set_source_enabled') e`)).e);

  // ---------------------------------------------------------- sweep: nothing changed → nothing
  const sweep = async () => (await one(`select public.ai_ingest_sweep('schedule') v`)).v;
  const sweepRows = async () => (await one(`select count(*)::int n from public.ai_ingest_runs where kind = 'sweep'`)).n;
  const drain = async () => {
    await q(`update public.ai_ingest_queue set not_before = now() - interval '1 second' where status = 'pending'`);
    return runWorker({ rpc, embed: fakeEmbed, workerId: `qa-sched-${crypto.randomUUID()}` });
  };
  // Mig 380 excludes the "testing doc". Until a real sweep has soft-deleted it,
  // the first sweep queues exactly that; settle it so the store is in sync.
  const settle = await sweep();
  check('380: a first sweep queues nothing, or only the excluded testing doc\'s soft delete',
    settle.enqueued_total === 0 || J(settle.enqueued) === J({ kb_article: { 'not indexable': 1 } }), J(settle.enqueued));
  if (settle.enqueued_total) {
    const ws = await drain();
    check('380: the drain soft-deletes the excluded testing doc', ws.soft_deleted === 1 && (await one(`select status from public.ai_documents where source_type = 'kb_article' and source_id = $1`, [TESTING_DOC])).status === 'deleted', J(ws.errors));
  }
  const base = await sweepRows();
  const s0 = await sweep();
  check('sweep with nothing changed (the live store is in sync) enqueues 0, records a sweep run', s0.status === 'swept' && s0.enqueued_total === 0 && (await sweepRows()) === base + 1, J(s0));
  const run0 = await one(`select stats from public.ai_ingest_runs where kind = 'sweep' order by id desc limit 1`);
  check('the sweep run row: trigger, enqueued, ms, ignored_sources recorded', run0.stats.trigger === 'schedule' && 'enqueued_total' in run0.stats && Array.isArray(run0.stats.ignored_sources), J(run0.stats));
  const s0b = await sweep();
  check('a second sweep enqueues 0 (idempotent)', s0b.enqueued_total === 0, J(s0b));

  // M1: an unknown and a deny-listed name, next to a test fixture name.
  // 380 (M1-b) refuses them when saved; 379's ignore-and-report is the second
  // net behind it, tested here with the save check switched off.
  const savedSources = (await one(`select ingest_sources v from public.ai_assistant_config where id = 1`)).v;
  const refused = await c.query('savepoint m1').then(() => q(`update public.ai_assistant_config set ingest_sources = ingest_sources || '{kb_articles,payroll,qa_test}' where id = 1`))
    .then(() => 'accepted', (e) => e.code);
  await c.query('rollback to savepoint m1');
  check('M1-b (380): saving a typo / a deny-listed name is refused at once (23514)', refused === '23514', refused);
  await q(`alter table public.ai_assistant_config disable trigger ai_assistant_config_sources_check`);
  await q(`update public.ai_assistant_config set ingest_sources = ingest_sources || '{kb_articles,payroll,qa_test}' where id = 1`);
  await q(`alter table public.ai_assistant_config enable trigger ai_assistant_config_sources_check`);
  const sM1 = await sweep();
  const types = (await one(`select public.ai_source_types() v`)).v;
  const stM1 = (await one(`select public.ai_ingest_stats() v`)).v;
  check('M1: typos / deny-listed names are ignored (sweep still runs every real source, 0 enqueued)', sM1.status === 'swept' && sM1.enqueued_total === 0, J(sM1));
  check('M1: ai_source_types() drops them but keeps the test fixture name; stats show them as ignored',
    !types.includes('kb_articles') && !types.includes('payroll') && types.includes('qa_test') && J(stM1.ignored_sources) === J(['kb_articles', 'payroll']), `${J(types)} ignored ${J(stM1.ignored_sources)}`);
  await q(`update public.ai_assistant_config set ingest_sources = $1 where id = 1`, [savedSources]);

  // ---------------------------------------------------------- sweep: a new approved report → 1 upsert
  const report = (await one(`insert into public.reports (brand_id, author_id, type, period_start, period_end, period_label, status, data)
      values ($1, $2, 'weekly', '2099-03-02', '2099-03-08', 'QA Zq Sweep', 'approved', $3) returning id`,
    [brand, P.apc, { overallInsights: '<p>QA Zq sweep: one hero video carried the week.</p>', recommendations: '<p>QA Zq: brief two creators.</p>' }])).id;
  const s1 = await sweep();
  const qRep = await q(`select op, priority, reason from public.ai_ingest_queue where status = 'pending' and source_type = 'report' and source_id = $1`, [report]);
  check('sweep after one synthetic approved report → exactly 1 upsert (report missing), priority 8, reason sweep',
    s1.enqueued_total === 1 && J(s1.enqueued) === J({ report: { missing: 1 } }) && qRep.length === 1 && qRep[0].op === 'upsert' && qRep[0].priority === 8 && qRep[0].reason === 'sweep', `${J(s1.enqueued)} ${J(qRep)}`);
  const w1 = await drain();
  const doc = (t, id) => one(`select status, acl_mode, metadata from public.ai_documents where source_type = $1 and source_id = $2`, [t, String(id)]);
  check('drain: the report is written (fake embedder), nothing else claimed', w1.written === 1 && w1.claimed === 1 && (await doc('report', report))?.status === 'active', J({ w: w1.written, c: w1.claimed, e: w1.errors }));
  check('sweep after the drain → 0', (await sweep()).enqueued_total === 0);

  // ---------------------------------------------------------- unapproving it → a soft-delete op
  await q(`update public.reports set status = 'submitted' where id = $1`, [report]);
  const s2 = await sweep();
  const qDel = await q(`select op from public.ai_ingest_queue where status = 'pending' and source_type = 'report' and source_id = $1`, [report]);
  check('sweep after un-approving it → 1 delete op (not indexable)', s2.enqueued_total === 1 && J(s2.enqueued) === J({ report: { 'not indexable': 1 } }) && qDel[0]?.op === 'delete', `${J(s2.enqueued)} ${J(qDel)}`);
  const w2 = await drain();
  check('drain: the worker soft-deletes it (hidden, vectors kept); next sweep → 0', w2.soft_deleted === 1 && (await doc('report', report))?.status === 'deleted' && (await sweep()).enqueued_total === 0, J({ sd: w2.soft_deleted }));

  // ---------------------------------------------------------- on-demand guards
  await q(`delete from public.ai_ingest_runs where kind = 'sweep'`);   // this transaction's sweeps only (none were on dev: pre-379)
  const asBoss = async () => {
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [J({ sub: P.boss, role: 'authenticated' })]);
    await c.query('set local role authenticated');
    try { return (await one(RUN)).v; } finally { await c.query('reset role'); await c.query(`select set_config('request.jwt.claims', '', true)`); }
  };
  const g1 = await asBoss();
  const g1row = await one(`select id, started_at, stats from public.ai_ingest_runs where kind = 'sweep' order by id desc limit 1`);
  check('manual run by the Boss → swept; the run row says trigger manual, triggered_by = the Boss',
    g1.status === 'swept' && g1row.stats.trigger === 'manual' && g1row.stats.triggered_by === P.boss, J(g1row.stats));
  const g2 = await asBoss();
  check('a second click at once → too_soon, next_allowed_at = the last sweep + 5 min, no new run',
    g2.status === 'too_soon' && new Date(g2.next_allowed_at).getTime() === new Date(g1row.started_at).getTime() + 5 * 60_000 && (await sweepRows()) === 1, J(g2));
  await q(`update public.reports set status = 'approved' where id = $1`, [report]);   // something for the next sweep to queue
  await q(`update public.ai_ingest_runs set started_at = started_at - interval '6 minutes' where kind = 'sweep'`);
  const g3 = await asBoss();
  check('6 minutes later → swept again (it queues the re-approved report)', g3.status === 'swept' && g3.enqueued_total === 1, J(g3));
  await q(`update public.ai_ingest_runs set started_at = started_at - interval '6 minutes' where kind = 'sweep'`);
  const g4 = await asBoss();
  check('while that sweep\'s item is still queued → already_running (no pile-up)', g4.status === 'already_running' && g4.queued === 1 && (await sweepRows()) === 2, J(g4));
  const w3 = await drain();
  const g5 = await asBoss();
  check('once drained (re-approved with unchanged text: 0 embeds) → a new run is allowed, enqueues 0',
    w3.written === 1 && w3.embedded_chunks === 0 && g5.status === 'swept' && g5.enqueued_total === 0, J({ w3: w3.written, e: w3.embedded_chunks, g5 }));

  // ---------------------------------------------------------- rolling 12 hours
  const last = (await one(`select max(started_at) t from public.ai_ingest_runs where kind = 'sweep' and error is null`)).t;
  const st = (await one(`select public.ai_ingest_stats() v`)).v;
  check('ai_ingest_stats: last_sweep_at = the manual run T, next_sweep_due_at = T + 12 h',
    new Date(st.last_sweep_at).getTime() === new Date(last).getTime() && new Date(st.next_sweep_due_at).getTime() === new Date(last).getTime() + 12 * 3600_000, `${st.last_sweep_at} → ${st.next_sweep_due_at}`);
  const ifDue = async () => (await one(`select public.ai_ingest_sweep_if_due() v`)).v;
  const n0 = await sweepRows();
  const d1 = await ifDue();
  check('hourly check right after a manual run → not_due (the manual run reset the clock), no new run', d1.status === 'not_due' && (await sweepRows()) === n0, J(d1));
  await q(`update public.ai_ingest_runs set started_at = started_at - interval '11 hours 50 minutes' where kind = 'sweep'`);
  check('11 h 50 min later → still not_due', (await ifDue()).status === 'not_due' && (await sweepRows()) === n0);
  await q(`update public.ai_ingest_runs set started_at = started_at - interval '6 minutes' where kind = 'sweep'`);
  const d2 = await ifDue();
  const schedRow = await one(`select stats from public.ai_ingest_runs where kind = 'sweep' order by id desc limit 1`);
  check('11 h 56 min later (within the 5-minute slack of 12 h) → sweeps once, trigger schedule', d2.status === 'swept' && (await sweepRows()) === n0 + 1 && schedRow.stats.trigger === 'schedule', J(d2));
  const d3 = await ifDue();
  check('the next hourly check → not_due again (one sweep per 12 h)', d3.status === 'not_due' && (await sweepRows()) === n0 + 1, J(d3));
  const g6 = await asBoss();
  check('a manual run right after the scheduled one → too_soon', g6.status === 'too_soon', J(g6));

  // ---------------------------------------------------------- 374: the KB security trigger
  await c.query(mig(374));
  check('374 executes inside the transaction', true);
  const trg = await q(`select tgname, tgrelid::regclass::text rel from pg_trigger where tgname like 'ai\\_%' and not tgisinternal
      and tgrelid in ('public.reports'::regclass, 'public.kb_articles'::regclass, 'public.ai_assistant_docs'::regclass,
                      'public.tts_articles'::regclass, 'public.incentives'::regclass, 'public.brands'::regclass)`);   // the source tables only (380, 382, 383 add their own ai_* triggers elsewhere)
  check('374: exactly one ingest trigger, on kb_articles; no content triggers on reports / docs / tts / incentives / brands',
    trg.length === 1 && trg[0].rel === 'kb_articles', J(trg));
  const pendingNow = () => q(`select source_type, source_id, op, priority, reason, extract(epoch from not_before - now())::int due_in
      from public.ai_ingest_queue where status = 'pending' order by id`);
  const kb = (await one(`insert into public.kb_articles (title, url, category, visibility, approval_status, created_by, version)
      values ('QA Zq Sweep KB', 'https://example.com/qa-sweep', 'operational_sops', 'office', 'approved', $1, 1) returning id`, [P.boss])).id;
  await q(`update public.reports set data = jsonb_set(data, '{overallInsights}', '"QA Zq edited"') where id = $1`, [report]);
  await q(`update public.kb_articles set visibility = 'role', visible_to_roles = '{ol}' where id = $1`, [kb]);   // not in the store yet
  check('374: a new KB article, a report edit and an ACL change of an article NOT in the store enqueue nothing (they wait for the sweep)',
    (await pendingNow()).length === 0, J(await pendingNow()));
  await q(`update public.kb_articles set visibility = 'office', visible_to_roles = '{}' where id = $1`, [kb]);
  const sK = await sweep();
  check('sweep picks up the new KB article (and the edited report)', sK.enqueued?.kb_article?.missing === 1 && sK.enqueued?.report?.changed === 1, J(sK.enqueued));
  await drain();
  check('drain: the KB article is in the store, office visibility', (await doc('kb_article', kb))?.metadata?.visibility === 'office');
  await q(`update public.kb_articles set title = 'QA Zq Sweep KB (edited)' where id = $1`, [kb]);
  check('374: a title edit of an indexed article enqueues nothing (content waits for the sweep)', (await pendingNow()).length === 0, J(await pendingNow()));
  await q(`update public.kb_articles set visibility = 'role', visible_to_roles = '{ol}' where id = $1`, [kb]);
  const k1 = await pendingNow();
  check('374: visibility tightened → one acl op, priority 0, due NOW, reason trigger; no content op',
    k1.length === 1 && k1[0].source_id === kb && k1[0].op === 'acl' && k1[0].priority === 0 && k1[0].due_in <= 0 && k1[0].reason === 'trigger', J(k1));
  const wK = await runWorker({ rpc, embed: fakeEmbed, workerId: 'qa-sched-acl' });
  const kbDoc = await doc('kb_article', kb);
  check('drain (what the tick does within ~1 min): the stored ACL is now role {ol}', wK.succeeded >= 1 && kbDoc.metadata.visibility === 'role', J({ s: wK.succeeded, v: kbDoc.metadata.visibility }));
  for (const [col, val] of [['visible_to_users', `{${P.apc}}`], ['submitted_by', P.apc], ['created_by', P.developer], ['approval_status', 'pending']]) {
    await q(`update public.kb_articles set ${col} = $2 where id = $1`, [kb, val]);
    const k = await pendingNow();
    check(`374: ${col} change → acl op p0, due now`, k.length === 1 && k[0].op === 'acl' && k[0].priority === 0 && k[0].due_in <= 0, J(k));
    await q(`update public.ai_ingest_queue set status = 'done', done_at = now() where status = 'pending'`);
  }
  await q(`update public.kb_articles set approval_status = 'approved' where id = $1`, [kb]);
  await q(`update public.ai_ingest_queue set status = 'done', done_at = now() where status = 'pending'`);
  await q('delete from public.kb_articles where id = $1', [kb]);
  const k2 = await pendingNow();
  check('374: an indexed article DELETED → delete op p0, due now', k2.length === 1 && k2[0].op === 'delete' && k2[0].priority === 0 && k2[0].due_in <= 0, J(k2));
  await q(`update public.ai_ingest_queue set status = 'done', done_at = now() where status = 'pending'`);
  await q(`update public.ai_assistant_config set ingest_sources = array_remove(ingest_sources, 'kb_article') where id = 1`);
  const kb2 = (await one(`insert into public.kb_articles (title, url, category, visibility, approval_status, created_by, version)
      values ('QA Zq Sweep KB 2', 'https://example.com/qa-sweep2', 'operational_sops', 'office', 'approved', $1, 1) returning id`, [P.boss])).id;
  await q(`insert into public.ai_documents (source_type, source_id, title, acl_mode, doc_hash) values ('kb_article', $1, 'QA', 'kb', 'x')`, [kb2]);
  await q(`update public.kb_articles set visibility = 'private' where id = $1`, [kb2]);
  check('374: kb_article switched off in ingest_sources → the trigger enqueues nothing', (await pendingNow()).length === 0);
  await q(`update public.ai_assistant_config set ingest_sources = $1 where id = 1`, [savedSources]);

  // guard: a broken enqueue never blocks the user's save
  await q(`create or replace function public.ai_enqueue(p_type text, p_id text, p_op text, p_priority int default 5,
      p_debounce interval default interval '0', p_reason text default 'trigger') returns void language plpgsql as $$ begin raise exception 'boom'; end $$`);
  let saved = false;
  try {
    await q('savepoint g');
    await q(`update public.kb_articles set visibility = 'office' where id = $1`, [kb2]);
    saved = (await one(`select visibility from public.kb_articles where id = $1`, [kb2])).visibility === 'office';
    await q('release savepoint g');
  } catch (e) { await q('rollback to savepoint g'); check(`guard error: ${e.message}`, false); }
  check('374: a failing ai_enqueue never blocks the save (warning only)', saved);

  // Nothing real was touched: the only ai_documents changes are the synthetic ones.
  const realAfter = await one(`select count(*)::int n, md5(string_agg(id::text || doc_hash || status, ',' order by id)) h from public.ai_documents
      where not (source_type = 'report' and source_id = $1) and not (source_type = 'kb_article' and source_id = any($2))`, [report, [kb, kb2, TESTING_DOC]]);
  check('the real ai_documents are untouched (same count and hash as before, synthetic rows aside)', realAfter.n === docs0.n && realAfter.h === docs0.h, `${realAfter.n} vs ${docs0.n}`);
} catch (e) {
  check(`test aborted: ${e.message}`, false, e.stack?.split('\n')[1] ?? '');
} finally {
  let intact = false;
  try { intact = (await one('select pg_current_xact_id()::text as x')).x === xid; } catch { intact = true; }
  await c.query('rollback').catch(() => {});
  await c.end().catch(() => {});
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? `  [${r.detail}]` : ''}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed. ${intact ? '(rolled back: migrations, jobs and every row are gone)' : '!!! transaction id changed: something may have been COMMITTED'}`);
  process.exitCode = failed || !intact ? 1 : 0;
}
