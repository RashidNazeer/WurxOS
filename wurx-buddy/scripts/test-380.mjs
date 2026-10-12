// ============================================================
// Migrations 380 (save-time source check, exclusion list, crawl state) and
// 381 (crawl schedule) test. DEV ONLY; nothing persists.
//
//   node --experimental-strip-types scripts/test-380.mjs [--no-real] [--pages 8]
//
// 1. Real pages, READ-ONLY (skipped with --no-real): fetches the Academy sitemap
//    and --pages real pages (essays + 2 courses) at the crawler's politeness
//    gap, parses them with the shared crawl code and the importer's winner
//    rules, and compares each article with dev's tts_articles (a read-only
//    transaction). No write of any kind.
// 2. ONE transaction, ALWAYS rolled back: executes 379 + 380 + 381, then
//    • M1-b: bad ingest_sources names are refused when saved; 379's net stays;
//    • exclusions: the seeded "testing doc" is hidden from ai_search /
//      ai_get_chunks at once (Boss included), a sweep queues its soft delete,
//      the worker (fake embedder) performs it, the next sweep does not re-add
//      it; un-excluding revives it; only the Boss may read / write the list;
//    • the crawl state machine with SYNTHETIC pages (ids qa-zq-*): discover,
//      JS-shell retry, dead page, finalize through the importer's rules, only
//      changed rows written, missed 3 crawls → retired, back → revived, a
//      failed course's lessons not counted as missing, the outage guard, the
//      lease, the tick;
//    • the crawl again with the step-1 REAL pages (served from memory): real
//      rows unchanged are not rewritten, nothing real is retired.
// ============================================================
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { ASSISTANT, devDbUrl, SSL, stripBom } from './dev-env.mjs';
import { DEFAULT_CONFIG } from '../../supabase/functions/_shared/ai/config.ts';
import { pgRpc } from '../../supabase/functions/_shared/ai/ingest/db.ts';
import { crawlToRows } from '../../supabase/functions/_shared/ai/ingest/ttsImport.ts';
import { runWorker } from '../../supabase/functions/_shared/ai/ingest/worker.ts';
import { httpFetcher, runCrawl } from '../../supabase/functions/_shared/ai/crawl/runner.ts';
import { classifyPage, pageRecords, sitemapItems, TTS_SITEMAP } from '../../supabase/functions/_shared/ai/crawl/ttsPages.ts';

const args = process.argv.slice(2);
const REAL = !args.includes('--no-real');
const PAGES = Number(args[args.indexOf('--pages') + 1]) || 8;
const TESTING_DOC = '833b9bda-8282-41dc-a8da-8ff3f032354d';

const results = [];
const check = (name, ok, detail = '') => { results.push({ ok: !!ok, name, detail: String(detail).slice(0, 220) }); };
const mig = (n) => stripBom(fs.readFileSync(path.join(ASSISTANT, '..', 'supabase/migrations', fs.readdirSync(path.join(ASSISTANT, '..', 'supabase/migrations')).find((f) => f.startsWith(`${n}_`))), 'utf8'));
const J = JSON.stringify;

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

const newClient = async () => {
  const c = new pg.Client({ connectionString: devDbUrl(), ssl: SSL, connectionTimeoutMillis: 20_000, query_timeout: 180_000 });
  c.on('error', () => {});
  await c.connect();
  return c;
};

// ---------------------------------------------------------------- 1. real pages, read-only
const cache = new Map();   // url → {status, text}: step 2 replays these, no second fetch
let realSitemap = null;
if (REAL) {
  const net = httpFetcher();
  let last = 0;
  const polite = async (url, accept) => {
    const wait = last + 2500 + Math.random() * 1000 - Date.now();
    if (last && wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    const r = await net(url, accept);
    cache.set(url, r);
    return r;
  };
  try {
    const sm = await polite(TTS_SITEMAP, 'application/json');
    const all = sitemapItems(JSON.parse(sm.text));
    const essays = all.filter((i) => i.kind === 'essay');
    const courses = all.filter((i) => i.kind === 'course');
    const pick = [...essays.filter((_, i) => i % Math.floor(essays.length / (PAGES - 2)) === 0).slice(0, PAGES - 2), ...courses.slice(0, 2)];
    check(`real sitemap: ${essays.length} essays, ${courses.length} courses`, essays.length > 500 && courses.length > 10, `${all.length} items`);
    const records = [];
    const outcome = {};
    for (const item of pick) {
      let r;
      for (let attempt = 0; attempt < 3; attempt++) {   // a JS shell is transient: the crawler retries it later
        r = classifyPage((await polite(item.url, 'text/html')).status, cache.get(item.url).text, item.kind === 'essay' ? 'essay/page' : 'course/page');
        if (r.kind !== 'retry') break;
      }
      outcome[r.kind] = (outcome[r.kind] ?? 0) + 1;
      if (r.kind === 'ok') records.push(...pageRecords(item, r.data).records);
    }
    check(`real pages parsed: ${pick.length} pages → ${records.length} records`, (outcome.ok ?? 0) >= pick.length - 1 && records.length >= pick.length, J(outcome));
    const plan = await crawlToRows(records);
    const c = await newClient();
    try {
      await c.query('begin read only');
      const { rows } = await c.query('select knowledge_id, content_hash, is_active from public.tts_articles where knowledge_id = any($1)', [plan.rows.map((r) => r.knowledge_id)]);
      await c.query('rollback');
      const stored = new Map(rows.map((r) => [r.knowledge_id, r]));
      const diff = { unchanged: 0, changed: 0, new: 0 };
      for (const r of plan.rows) {
        const s = stored.get(r.knowledge_id);
        diff[!s ? 'new' : s.content_hash === r.content_hash && s.is_active ? 'unchanged' : 'changed']++;
      }
      check(`DRY RUN vs dev tts_articles (read-only): ${J(diff)}; ${plan.skippedEmpty.length} without text`, diff.unchanged + diff.changed + diff.new === plan.rows.length && diff.unchanged > 0, J(diff));
    } finally { await c.end(); }
    realSitemap = J({ data: pick.map((i) => ({ loc: i.url })) });
  } catch (e) {
    check(`real-page dry run aborted: ${e.message}`, false);
  }
}

// ---------------------------------------------------------------- 2. rolled back
const c = await newClient();
const q = async (sql, params) => (await c.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
const rpc = pgRpc(c, { savepoints: true });
const rpcPlain = pgRpc(c);   // the crawl's RPCs raise nothing expected: one round trip each
const rpcFast = process.env.DEBUG380 ? async (fn, a) => { console.error(`rpc ${fn} ${JSON.stringify(a).slice(0, 120)}`); return rpcPlain(fn, a); } : rpcPlain;
let xid = null;
try {
  await c.query(`set idle_in_transaction_session_timeout = '60s'`);
  await c.query('begin');
  xid = (await one('select pg_current_xact_id()::text as x')).x;
  await c.query(`set local lock_timeout = '10s'`);
  const busy = await one(`select count(*)::int n from public.ai_ingest_queue where status in ('pending','processing')`);
  if (busy.n) throw new Error(`dev queue has ${busy.n} pending/processing rows; refusing`);
  const tts0 = await one(`select count(*)::int n, count(*) filter (where is_active)::int a, md5(string_agg(knowledge_id || content_hash || is_active || missed_crawls || ctid::text, ',' order by knowledge_id)) h from public.tts_articles`);

  await c.query(mig(379));
  await c.query(mig(380));
  await c.query(mig(380));
  check('379 + 380 execute inside the transaction; 380 re-runs cleanly (idempotent)', true);
  await c.query(mig(381));
  await c.query(mig(381));
  const jobs = Object.fromEntries((await q(`select jobname, schedule, command from cron.job where jobname like 'ai-tts-%'`)).map((j) => [j.jobname, j]));
  check('381: ai-tts-crawl-start Saturday 23:00 GMT (Sunday 04:00 PKT) → ai_crawl_start(); tick every minute; idempotent (2 jobs)',
    jobs['ai-tts-crawl-start']?.schedule === '0 23 * * 6' && /ai_crawl_start\(\)/.test(jobs['ai-tts-crawl-start'].command)
    && jobs['ai-tts-crawl-tick']?.schedule === '* * * * *' && /ai_crawl_tick\(\)/.test(jobs['ai-tts-crawl-tick'].command) && Object.keys(jobs).length === 2, J(jobs));

  // ---------------------------------------------------------- people
  const person = async (role) => (await one(`select id from public.profiles where role = $1 and is_active and deleted_at is null order by id limit 1`, [role]))?.id;
  const P = {};
  for (const r of ['boss', 'developer', 'apc', 'ol', 'tl']) { P[r] = await person(r); if (!P[r]) throw new Error(`no active ${r} on dev`); }
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

  // ---------------------------------------------------------- M1-b
  const saved = (await one(`select ingest_sources v from public.ai_assistant_config where id = 1`)).v;
  const save = (list, uid = P.boss) => asUser(uid, `update public.ai_assistant_config set ingest_sources = $1 where id = 1`, [list]);
  const typo = await save(['report', 'kb_artcle']);
  check('M1-b: the Boss saving a typo (kb_artcle) is refused at once (23514), naming it and the allowed list',
    typo.code === '23514' && /kb_artcle/.test(typo.err) && /allowed: kb_article, ai_doc/.test(typo.err), typo.err);
  for (const bad of [['payroll'], ['kb_articles'], ['report', null], ['Report'], ['qa_salary_x']]) {
    const r = await save(bad);
    check(`M1-b: ${J(bad)} refused`, r.code === '23514', r.err || `n=${r.n}`);
  }
  for (const good of [saved, [], ['tts_article'], ['report', 'qa_test', 'srchtest', 'zzz_custom', 'acltest']]) {
    const r = await save(good);
    check(`M1-b: ${J(good)} accepted (canon names and the test hook)`, r.n === 1 && !r.err, r.err);
  }
  const direct = await c.query('savepoint d').then(() => q(`update public.ai_assistant_config set ingest_sources = '{report,kb_artcle}' where id = 1`)).then(() => 'accepted', (e) => e.code);
  await c.query('rollback to savepoint d');
  check('M1-b: a direct SQL session (postgres) is refused too', direct === '23514', direct);
  const devSave = await save(['report'], P.developer);
  check('M1-b: a developer still cannot change the setting (RLS: 0 rows)', devSave.n <= 0, J(devSave));
  await c.query('savepoint net');
  await q(`alter table public.ai_assistant_config disable trigger ai_assistant_config_sources_check`);
  await q(`update public.ai_assistant_config set ingest_sources = ingest_sources || '{kb_articles,payroll}' where id = 1`);
  const ignored = (await one(`select public.ai_ignored_sources() v, public.ai_source_types() t`));
  await c.query('rollback to savepoint net');
  check('379 net kept: a bad name that got in anyway (trigger bypassed) is ignored and reported',
    J(ignored.v) === J(['kb_articles', 'payroll']) && !ignored.t.includes('payroll'), J(ignored));

  // ---------------------------------------------------------- exclusions
  const ex = await one(`select reason, excluded_by from public.ai_excluded_documents where source_type = 'kb_article' and source_id = $1`, [TESTING_DOC]);
  check('seed: the "testing doc" KB article is excluded, with its reason', ex?.reason === 'junk test article, Owner 2026-09-29', J(ex));
  const tdoc = await one(`select id, status from public.ai_documents where source_type = 'kb_article' and source_id = $1`, [TESTING_DOC]);
  const other = await one(`select d.id, d.source_id from public.ai_documents d where d.source_type = 'kb_article' and d.status = 'active' and d.source_id <> $1
      and exists (select 1 from public.ai_chunks c where c.document_id = d.id) order by d.source_id limit 1`, [TESTING_DOC]);
  check('pre: the testing doc is active in the store (the first ingestion indexed it)', tdoc?.status === 'active', J(tdoc));
  const search = (uid, text) => asUser(uid, `select source_id from public.ai_search(null::extensions.vector, $1, array['kb_article'], null, null, null, 100) s`, [text]);
  const chunks = (uid, doc) => asUser(uid, `select chunk_id from public.ai_get_chunks($1, 0, 5)`, [doc]);
  const hiddenFor = async (label, uid) => {
    const s = await search(uid, 'testing doc');
    const g = await chunks(uid, tdoc.id);
    const o = await chunks(uid, other.id);
    check(`hidden at once for ${label}: ai_search never returns it, ai_get_chunks returns nothing (another KB doc still does)`,
      !s.err && !s.rows.some((r) => r.source_id === TESTING_DOC) && !g.err && g.rows.length === 0 && o.rows.length > 0, `${s.err}${g.err} search ${s.rows.length} other ${o.rows.length}`);
  };
  await hiddenFor('the Boss', P.boss);
  await hiddenFor('an OL', P.ol);
  const svc = await asUser(null, `select source_id from public.ai_search(null::extensions.vector, 'testing doc', array['kb_article'], null, null, null, 30, $1) s`, [P.boss], 'service_role');
  check('hidden for the service role searching as the Boss (the assistant path)', !svc.err && !svc.rows.some((r) => r.source_id === TESTING_DOC), svc.err);
  await c.query('savepoint unex');
  await q(`delete from public.ai_excluded_documents where source_id = $1`, [TESTING_DOC]);
  const visible = await search(P.boss, 'testing doc');
  await c.query('rollback to savepoint unex');
  check('control: without the exclusion row the Boss does find it', visible.rows.some((r) => r.source_id === TESTING_DOC), `${visible.err} ${visible.rows.length}`);
  const isrc = (await one(`select x from jsonb_array_elements(public.ai_ingest_source('kb_article', array[$1], false)) x`, [TESTING_DOC])).x;
  check('ai_ingest_source marks it {indexable:false, excluded:true}', isrc.indexable === false && isrc.excluded === true, J(isrc));

  const sweep = async () => (await one(`select public.ai_ingest_sweep('schedule') v`)).v;
  const s1 = await sweep();
  const qd = await one(`select op, reason from public.ai_ingest_queue where status = 'pending' and source_type = 'kb_article' and source_id = $1`, [TESTING_DOC]);
  check('the next sweep queues its soft delete (kb_article: not indexable)', s1.enqueued?.kb_article?.['not indexable'] >= 1 && qd?.op === 'delete' && qd.reason === 'sweep', `${J(s1.enqueued)} ${J(qd)}`);
  check('... and, the store being in sync, nothing else', s1.enqueued_total === 1, `total ${s1.enqueued_total}: ${J(s1.enqueued)}`);
  await q(`update public.ai_ingest_queue set status = 'done', done_at = now() where status = 'pending' and not (source_type = 'kb_article' and source_id = $1)`, [TESTING_DOC]);
  await q(`update public.ai_ingest_queue set not_before = now() - interval '1 second' where status = 'pending'`);
  const w = await runWorker({ rpc, embed: fakeEmbed, workerId: `qa-380-${crypto.randomUUID()}` });
  const after = await one(`select status, chunk_count, (select count(*)::int from public.ai_chunks c where c.document_id = d.id) n from public.ai_documents d where d.id = $1`, [tdoc.id]);
  check('the drain soft-deletes it (status deleted, chunks and vectors kept), 0 embeds', w.soft_deleted === 1 && w.embedded_chunks === 0 && after.status === 'deleted' && after.n > 0, J({ sd: w.soft_deleted, e: w.embedded_chunks, after, err: w.errors }));
  const s2 = await sweep();
  check('the sweep after that queues nothing for it (never re-added)', !s2.enqueued?.kb_article && s2.enqueued_total === 0, J(s2.enqueued));
  await c.query('savepoint revive');
  await q(`delete from public.ai_excluded_documents where source_id = $1`, [TESTING_DOC]);
  const s3 = await sweep();
  await c.query('rollback to savepoint revive');
  check('un-excluding it → the next sweep revives it (kb_article: revived)', s3.enqueued?.kb_article?.revived === 1, J(s3.enqueued));

  // who may use the list
  const E = `('kb_article', '00000000-0000-4000-8000-00000000qa38')`;
  const bossIns = await asUser(P.boss, `insert into public.ai_excluded_documents (source_type, source_id, reason) values ${E.slice(0, -1)}, 'qa') returning excluded_by`);
  check('the Boss can add an exclusion (excluded_by = the Boss)', bossIns.n === 1 && bossIns.rows[0].excluded_by === P.boss, bossIns.err);
  const bossSel = await asUser(P.boss, `select * from public.ai_excluded_documents`);
  check('the Boss can read the list', bossSel.rows.some((r) => r.source_id === TESTING_DOC), bossSel.err);
  const bossDel = await asUser(P.boss, `delete from public.ai_excluded_documents where source_id = $1`, [TESTING_DOC]);
  check('the Boss can remove one', bossDel.n === 1, bossDel.err);
  for (const r of ['developer', 'ol', 'tl', 'apc']) {
    const sel = await asUser(P[r], `select * from public.ai_excluded_documents`);
    const ins = await asUser(P[r], `insert into public.ai_excluded_documents (source_type, source_id, reason) values ('kb_article', 'qa-x', 'x')`);
    const upd = await asUser(P[r], `update public.ai_excluded_documents set reason = 'x'`);
    const del = await asUser(P[r], `delete from public.ai_excluded_documents`);
    const tru = await asUser(P[r], `truncate public.ai_excluded_documents`);
    check(`a ${r} can neither read nor write the list (0 rows / RLS / no TRUNCATE)`,
      sel.rows.length === 0 && !sel.err && /row-level security/.test(ins.err) && upd.n === 0 && del.n === 0 && /permission denied/.test(tru.err),
      `sel ${sel.rows.length} ins ${ins.err.slice(0, 40)} upd ${upd.n} del ${del.n} tru ${tru.err.slice(0, 40)}`);
  }
  const anonSel = await asUser(null, `select * from public.ai_excluded_documents`, [], 'anon');
  check('anon has no privilege on the list', /permission denied/.test(anonSel.err), anonSel.err);

  // grants of the new functions
  const fns = await q(`select p.proname, pg_get_function_identity_arguments(p.oid) args, p.prosecdef,
        exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%') pinned,
        has_function_privilege('anon', p.oid, 'EXECUTE') anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') auth,
        has_function_privilege('service_role', p.oid, 'EXECUTE') svc
      from pg_proc p where p.pronamespace = 'public'::regnamespace
       and p.proname in ('ai_trg_ingest_sources_check','ai_crawl_holds','ai_crawl_start','ai_crawl_lease','ai_crawl_release','ai_crawl_note_error',
                         'ai_crawl_add_items','ai_crawl_next','ai_crawl_put','ai_crawl_read_records','ai_tts_apply','ai_crawl_finish','ai_crawl_tick',
                         'ai_can_read_document','ai_ingest_source')`);
  check('the 15 new / redefined functions exist once each', fns.length === 15, fns.map((f) => f.proname).join(','));
  const badGrant = fns.filter((f) => f.anon || f.auth || !f.svc || !f.prosecdef || !f.pinned);
  check('each is SECURITY DEFINER, search_path pinned, service_role only (not anon, not authenticated)', badGrant.length === 0, J(badGrant));
  const tbl = await q(`select c.relname, r.rolname, string_agg(p.priv, ',' order by p.o) filter (where has_table_privilege(r.rolname, c.oid, p.priv)) privs
      from pg_class c cross join (values ('anon'),('authenticated')) r(rolname)
      cross join (values ('SELECT',1),('INSERT',2),('UPDATE',3),('DELETE',4),('TRUNCATE',5),('REFERENCES',6),('TRIGGER',7)) p(priv, o)
     where c.relnamespace = 'public'::regnamespace and c.relname in ('ai_excluded_documents','ai_crawl_state','ai_crawl_items','ai_crawl_records')
     group by 1, 2 order by 1, 2`);
  const privs = Object.fromEntries(tbl.map((t) => [`${t.relname}/${t.rolname}`, t.privs ?? '']));
  check('table privileges: exclusions = S/I/U/D for authenticated (RLS: Boss only), nothing for anon; crawl_state = SELECT (RLS: Boss); items / records = none',
    privs['ai_excluded_documents/authenticated'] === 'SELECT,INSERT,UPDATE,DELETE' && privs['ai_excluded_documents/anon'] === ''
    && privs['ai_crawl_state/authenticated'] === 'SELECT' && privs['ai_crawl_state/anon'] === ''
    && privs['ai_crawl_items/authenticated'] === '' && privs['ai_crawl_records/authenticated'] === '' && privs['ai_crawl_items/anon'] === '', J(privs));
  const cs = await asUser(P.developer, `select * from public.ai_crawl_state`);
  const csb = await asUser(P.boss, `select status from public.ai_crawl_state`);
  check('ai_crawl_state: the Boss reads it, a developer sees nothing', csb.rows.length === 1 && cs.rows.length === 0, `${csb.rows.length}/${cs.rows.length}`);

  // ---------------------------------------------------------- the crawl: tick and lease
  const posts = async () => (await one(`select count(*)::int n from net.http_request_queue`)).n;
  const state = () => one(`select status, crawl_no, lease_owner, finalize_after, stats from public.ai_crawl_state where id = 1`);
  const p0 = await posts();
  await q('select public.ai_crawl_tick()');
  check('tick: no ai_crawl_url → no request', (await posts()) === p0);
  await q(`update public.app_config set value = 'https://qa.invalid/functions/v1/tts-crawl' where key = 'ai_crawl_url'`);
  await q('select public.ai_crawl_tick()');
  check('tick: idle (no crawl running) → no request', (await posts()) === p0, J(await state()));
  const st1 = (await one(`select public.ai_crawl_start() v`)).v;
  const st2 = (await one(`select public.ai_crawl_start() v`)).v;
  check('ai_crawl_start → started; a second start while it runs → already_running', st1.status === 'started' && st2.status === 'already_running', J([st1, st2]));
  await q('select public.ai_crawl_tick()');
  const post = await one(`select url, convert_from(body, 'utf8') body from net.http_request_queue order by id desc limit 1`);
  check('tick while a crawl runs → one POST {mode:continue} to ai_crawl_url (queued here, never sent)', (await posts()) === p0 + 1 && /continue/.test(post.body) && /tts-crawl/.test(post.url), J(post));
  const l1 = await rpc('ai_crawl_lease', { p_worker: 'qa-a' });
  const l2 = await rpc('ai_crawl_lease', { p_worker: 'qa-b' });
  const pl = await posts();
  await q('select public.ai_crawl_tick()');
  const lost = await rpc('ai_crawl_add_items', { p_worker: 'qa-b', p_items: [] });
  check('lease: the first caller gets it, a second gets null; the tick does not post while it is held; a non-holder is refused',
    l1?.status === 'discover' && l2 === null && (await posts()) === pl && lost.ok === false && lost.reason === 'lost_lease', J({ l1, l2, lost }));
  await rpc('ai_crawl_release', { p_worker: 'qa-a' });

  // ---------------------------------------------------------- the crawl: synthetic pages
  const page = (loaderData) => `<html><script>window._ROUTER_DATA = ${J({ loaderData })};</script></html>`;
  const essay = (id, text) => ({ knowledge_detail: { knowledge_id: id, knowledge_name: `QA Zq ${id}`, knowledge_plain_content: text },
    learning_info: { learning_id: id, modify_time: 1710000000 } });
  const course = (lid, lessons) => ({ course_detail: { info: { name: `QA Zq course ${lid}` } },
    course_contents: lessons.map(([id, t]) => ({ content_id: id, knowledge: { knowledge_id: id, knowledge_name: `QA Zq lesson ${id}`, knowledge_content: J({ deltas: { 0: { ops: [{ insert: t }] } } }) } })) });
  const E20 = Array.from({ length: 20 }, (_, i) => `qa-zq-${String(i + 1).padStart(2, '0')}`);
  let site = { essays: E20, course: true, courseMode: 'ok', text: {}, shellOnce: new Set(), dead: new Set() };
  const synthFetch = async (url) => {
    if (url === TTS_SITEMAP) return { status: 200, text: J({ data: [...site.essays.map((id) => ({ loc: `https://seller-us.tiktok.com/university/essay?knowledge_id=${id}` })),
      ...(site.course ? [{ loc: 'https://seller-us.tiktok.com/university/course?learning_id=qa-zq-L&content_id=qa-zq-l1' }] : [])] }) };
    if (url.includes('learning_id=qa-zq-L')) {
      return site.courseMode === 'shell' ? { status: 200, text: '<html>shell</html>' }
        : { status: 200, text: page({ 'course/page': course('qa-zq-L', [['qa-zq-l1', 'Lesson one text.'], ['qa-zq-l2', 'Lesson two text.']]) }) };
    }
    const id = /knowledge_id=([^&]+)/.exec(url)[1];
    if (site.shellOnce.has(id)) { site.shellOnce.delete(id); return { status: 200, text: '<html><body>loading</body></html>' }; }
    if (site.dead.has(id)) return { status: 200, text: 'The content you are looking for does not exist' };
    return { status: 200, text: page({ 'essay/page': essay(id, site.text[id] ?? `QA Zq body of ${id}.`) }) };
  };
  let clock = 0;
  const crawlOpts = { rpc: rpcFast, fetch: synthFetch, now: () => clock, sleep: async (ms) => { clock += ms; }, random: () => 0, budgetMs: 10_000_000, followLinks: false };
  const bump = () => q(`update public.ai_crawl_items set not_before = now() - interval '1 second' where status = 'pending'`);
  // Runs calls until the crawl is idle, making retries due between calls (now() is frozen in this transaction).
  const crawl = async (label) => {
    const r0 = (await one(`select public.ai_crawl_start() v`)).v;
    const calls = [];
    for (let i = 0; i < 12; i++) {
      const r = await runCrawl({ ...crawlOpts, workerId: `qa-crawl-${label}-${i}` });
      calls.push(r);
      if (r.status === 'idle') break;
      await bump();
    }
    const s = await state();
    return { start: r0, calls, stats: s.stats, status: s.status };
  };
  const art = (id) => one(`select knowledge_id, is_active, missed_crawls, content_hash, ctid::text ctid, kind, course from public.tts_articles where knowledge_id = $1`, [id]);

  // the real catalogue is active: a 22-article crawl must not retire 1,000 real articles
  site.shellOnce.add('qa-zq-03');
  site.dead.add('qa-zq-20');
  const c1 = await crawl('c1');
  check('crawl 1: discover → crawl → finalize → idle; the JS shell was retried; the dead page skipped',
    c1.status === 'idle' && c1.stats.pages === 21 && c1.stats.dead === 1 && c1.stats.failed === 0 && c1.calls.length >= 2, J({ n: c1.calls.length, stats: c1.stats }));
  check('crawl 1: 21 new articles written (19 essays + 2 lessons), each once', c1.stats.inserted === 21 && c1.stats.updated === 0, J(c1.stats));
  check('crawl 1: outage guard: it saw 21 of ~1,000 active articles → retire step skipped, no real row touched',
    /saw 21 of/.test(c1.stats.retire_skipped ?? '') && c1.stats.missed === 0, c1.stats.retire_skipped);
  const tts1 = await one(`select count(*)::int n, md5(string_agg(knowledge_id || content_hash || is_active || missed_crawls || ctid::text, ',' order by knowledge_id)) h from public.tts_articles where knowledge_id not like 'qa-zq-%'`);
  check('crawl 1: the real tts_articles are byte-for-byte untouched (count, hash, missed, ctid)', tts1.n === tts0.n && tts1.h === tts0.h, `${tts1.n} vs ${tts0.n}`);

  // From here the real rows are set aside (inactive, in this transaction only) so the retire logic runs.
  await q(`update public.tts_articles set is_active = false where knowledge_id not like 'qa-zq-%'`);
  const before = await art('qa-zq-05');
  site = { ...site, essays: E20.filter((id) => id !== 'qa-zq-02'), text: { 'qa-zq-05': 'QA Zq body of qa-zq-05, edited.' }, shellOnce: new Set(), dead: new Set(['qa-zq-20']) };
  const c2 = await crawl('c2');
  const a2 = await art('qa-zq-02');
  const a5 = await art('qa-zq-05');
  const a6b = await art('qa-zq-06');
  check('crawl 2: only the edited article is rewritten (updated 1, unchanged 19; an unchanged row keeps its ctid)',
    c2.stats.updated === 1 && c2.stats.inserted === 0 && c2.stats.unchanged === 19 && a5.content_hash !== before.content_hash && a5.ctid !== before.ctid, J(c2.stats));
  check('crawl 2: qa-zq-02 left the sitemap → missed 1, still active; the dead qa-zq-20 was never stored',
    a2.missed_crawls === 1 && a2.is_active && c2.stats.retire_skipped === null && !(await art('qa-zq-20')), J({ a2, s: c2.stats.retire_skipped }));
  const c3 = await crawl('c3');
  const a6 = await art('qa-zq-06');
  check('crawl 3: missed 2; unchanged rows are not written at all (qa-zq-06 same ctid)', (await art('qa-zq-02')).missed_crawls === 2 && a6.ctid === a6b.ctid && c3.stats.updated === 0 && c3.stats.inserted === 0, J(c3.stats));
  const c4 = await crawl('c4');
  const a2r = await art('qa-zq-02');
  check('crawl 4: missing from 3 consecutive crawls → is_active = false (retired 1)', !a2r.is_active && a2r.missed_crawls === 3 && c4.stats.retired === 1, J({ a2r, s: c4.stats }));
  const sw = (await one(`select x from jsonb_array_elements(public.ai_ingest_source('tts_article', array['qa-zq-02'], false)) x`)).x;
  check('a retired article reads as not indexable (the next sweep soft-deletes it)', sw.indexable === false, J(sw));
  site.essays = E20;
  const c5 = await crawl('c5');
  const a2b = await art('qa-zq-02');
  check('crawl 5: it is back → revived (is_active, missed 0, counted as updated)', a2b.is_active && a2b.missed_crawls === 0 && c5.stats.updated === 1, J({ a2b, s: c5.stats }));

  // a lesson that is also an essay: one row, the essay wins, both kept in `course`
  site.essays = [...E20, 'qa-zq-l1'];
  const c6 = await crawl('c6');
  const l1r = await art('qa-zq-l1');
  check('an id that is both an essay and a course lesson → one row, the essay wins, the course is kept (importer rules)',
    l1r.kind === 'essay' && l1r.course?.[0]?.learning_id === 'qa-zq-L' && c6.stats.duplicate_ids === 1, J({ l1r: { kind: l1r.kind, course: l1r.course }, s: c6.stats }));

  // a course page that keeps failing: its stored lessons are NOT counted missing
  site.essays = E20;
  site.courseMode = 'shell';
  const c7 = await crawl('c7');
  const les = await art('qa-zq-l2');
  check('a course that fails 6 times → failed 1; its stored lesson is not counted missing (missed 0)',
    c7.stats.failed === 1 && les.missed_crawls === 0 && les.is_active, J({ les: les.missed_crawls, s: c7.stats }));
  check('... and 1 failed page of 21 (4.8 %) is under the 5 % guard, so retiring still ran', c7.stats.retire_skipped === null, c7.stats.retire_skipped);
  site.courseMode = 'ok';

  // an outage: the sitemap is fine but every page is a shell. Six retries per
  // page are covered above (c7); here the first attempt runs, then SQL fast-forwards them.
  const outage = { ...crawlOpts, fetch: async (url) => url === TTS_SITEMAP ? synthFetch(url) : { status: 200, text: '<html>shell</html>' } };
  await one(`select public.ai_crawl_start() v`);
  const o1 = await runCrawl({ ...outage, workerId: 'qa-out-1' });
  await q(`update public.ai_crawl_items set status = 'failed', attempts = 6, done_at = now() where status = 'pending'`);
  const o2 = await runCrawl({ ...outage, workerId: 'qa-out-2' });
  const so = (await state()).stats;
  const allActive = await one(`select count(*) filter (where missed_crawls > 0)::int m from public.tts_articles where knowledge_id like 'qa-zq-%'`);
  check('outage (every page a shell): all 21 failed → the retire step is skipped, nothing counted missing',
    o1.outcomes.retry === 21 && o2.status === 'idle' && so.failed === 21 && /21 of 21 pages failed/.test(so.retire_skipped ?? '') && so.missed === 0 && allActive.m === 0, J(so));

  // a sitemap failure while discovering: noted, retried by the next call; the 10th ends the crawl
  await one(`select public.ai_crawl_start() v`);
  const broken = { ...crawlOpts, fetch: async () => ({ status: 503, text: '' }) };
  const b1 = await runCrawl({ ...broken, workerId: 'qa-br-1' });
  const sb1 = await state();
  for (let i = 2; i <= 10; i++) await runCrawl({ ...broken, workerId: `qa-br-${i}` });
  const sb10 = await one(`select status, errors, stats->>'aborted' a from public.ai_crawl_state where id = 1`);
  check('sitemap HTTP 503: the call stops, the crawl stays in discover (retried next tick); 10 in a row → idle, aborted',
    b1.stopped === 'sitemap failed' && sb1.status === 'discover' && sb10.status === 'idle' && sb10.errors === 10 && /503/.test(sb10.a), J({ b1: b1.stopped, sb1: sb1.status, sb10 }));
  await q(`update public.tts_articles set is_active = true where knowledge_id not like 'qa-zq-%'`);   // undo the set-aside (rolled back anyway)

  // ---------------------------------------------------------- the crawl: the step-1 real pages, replayed
  if (REAL && realSitemap) {
    await q(`delete from public.tts_articles where knowledge_id like 'qa-zq-%'`);
    const replay = async (url) => url === TTS_SITEMAP ? { status: 200, text: realSitemap } : (cache.get(url) ?? { status: 599, text: 'not cached' });
    const t0 = await one(`select md5(string_agg(knowledge_id || content_hash || is_active || missed_crawls, ',' order by knowledge_id)) h,
        count(*) filter (where is_active)::int a from public.tts_articles`);
    await one(`select public.ai_crawl_start() v`);
    let rr;
    for (let i = 0; i < 12; i++) { rr = await runCrawl({ ...crawlOpts, fetch: replay, workerId: `qa-real-${i}` }); if (rr.status === 'idle') break; await bump(); }
    const sr = (await state()).stats;
    const t1 = await one(`select count(*) filter (where is_active)::int a from public.tts_articles`);
    check(`real pages through the whole pipeline: ${sr.pages} pages, ${sr.records} records → inserted ${sr.inserted}, updated ${sr.updated}, unchanged ${sr.unchanged}`,
      rr.status === 'idle' && sr.unchanged > 0 && sr.inserted + sr.updated + sr.unchanged > 0, J(sr));
    check('real pages: nothing real retired (guard: a handful of pages), active count unchanged', /saw \d+ of|pages failed/.test(sr.retire_skipped ?? '') && t1.a === t0.a, `${sr.retire_skipped} ${t1.a}/${t0.a}`);
  }
} catch (e) {
  check(`test aborted: ${e.message}`, false, e.stack?.split('\n').slice(1, 3).join(' '));
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
