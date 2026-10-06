// ============================================================
// Phase 2B integration test: the REAL worker core against the dev database,
// inside ONE transaction that is ALWAYS rolled back. DEV ONLY.
//
//   node --experimental-strip-types scripts/test-ingest.mjs [--no-real]
//
// Only SYNTHETIC rows ("QA Zq …", qa-* ids, period 2099) are written, and only
// inside this transaction; the store is live, so the run proves at the end that
// the real documents are unchanged and that its transaction id never changed
// (nothing committed). Migration 379 (not yet applied) is executed inside the
// transaction; 373/376/377 are applied on dev. The embedder is a deterministic fake that counts
// calls, except in the last step, which embeds 3 tiny texts with the real
// OpenAI model (< 100 tokens, ~$0.000002; skip with --no-real).
//
// What it proves (the Owner's "process each piece of data once"):
//   run 1 processes everything · run 2 processes nothing (0 embeds, 0 store
//   writes) · one edited insight → exactly 1 chunk embedded · only APPROVED
//   reports are indexed · KB visibility → 0 embeds, ACL updated · pipeline
//   bump → every document once, then idempotent · reopen → soft delete,
//   hidden · re-approve → 0 embeds · source DELETE → gone · backfill twice →
//   nothing the second time · TikTok import twice → nothing the second time ·
//   lost lock → write refused · allow-list + deny-list · ai_search ACL as
//   boss/OL/APCs · a source switched off in ai_assistant_config.ingest_sources
//   (hidden, drained, never re-added) and back on (revived, 0 embeds); only
//   the Boss may change that list (a Developer, like an APC or OL, is refused,
//   and still cannot edit the persona or read someone else's chats).
// ============================================================
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { ASSISTANT, devDbUrl, readEnv, SSL, stripBom } from './dev-env.mjs';
import { DEFAULT_CONFIG, PIPELINE_VERSION } from '../../supabase/functions/_shared/ai/config.ts';
import { pgRpc } from '../../supabase/functions/_shared/ai/ingest/db.ts';
import { importArticles } from '../../supabase/functions/_shared/ai/ingest/ttsImport.ts';
import { openAiEmbedder, runWorker } from '../../supabase/functions/_shared/ai/ingest/worker.ts';

const MODEL = DEFAULT_CONFIG.EMBED_MODEL;
const REAL = !process.argv.includes('--no-real');
const results = [];
const check = (name, ok, detail = '') => { results.push({ ok: !!ok, name, detail: String(detail).slice(0, 160) }); };

// Deterministic unit vector from the text (xorshift seeded by sha256).
function fakeVec(text) {
  const h = crypto.createHash('sha256').update(text).digest();
  let s = h.readUInt32LE(0) || 1;
  const v = new Array(DEFAULT_CONFIG.EMBED_DIMS);
  let n = 0;
  for (let i = 0; i < v.length; i++) {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    v[i] = s / 4294967296 - 0.5;
    n += v[i] * v[i];
  }
  n = Math.sqrt(n);
  return v.map((x) => Math.round((x / n) * 1e6) / 1e6);
}
const fake = { calls: 0, inputs: 0 };
const fakeEmbed = async (texts) => { fake.calls++; fake.inputs += texts.length; return { vectors: texts.map(fakeVec), tokens: texts.join(' ').length >> 2, requests: 1 }; };
const vecLit = (v) => `[${v.join(',')}]`;

const c = new pg.Client({ connectionString: devDbUrl(), ssl: SSL, connectionTimeoutMillis: 20_000, query_timeout: 180_000 });
c.on('error', () => {});
await c.connect();
const q = async (sql, params) => (await c.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
const rpc = pgRpc(c, { savepoints: true });

let xid = null;
let pipeline = PIPELINE_VERSION;
let docs0 = null;
try {
  // L6: if this process dies mid-run, the server ends the session (and its locks).
  await c.query(`set idle_in_transaction_session_timeout = '60s'`);
  await c.query('begin');
  xid = (await one('select pg_current_xact_id()::text as x')).x;
  await c.query(`set local lock_timeout = '10s'`);

  const busy = await one(`select count(*)::int n from public.ai_ingest_queue where status in ('pending','processing')`);
  if (busy.n) throw new Error(`the dev queue has ${busy.n} pending/processing rows; refusing to run (the worker would claim them)`);
  // The store is live since the first ingestion (2026-09-29): real documents are
  // only read here; the last check proves they are unchanged.
  docs0 = await one(`select count(*)::int n, md5(string_agg(id::text || doc_hash || status, ',' order by id)) h from public.ai_documents`);
  check('pre: no synthetic document is in the store', (await one(`select count(*)::int n from public.ai_documents where source_id like 'qa-%' or title like 'QA Zq%'`)).n === 0);

  // 373 / 376 / 377 are applied on dev (re-running them would add a second
  // ai_search beside mig 378's); 379 (the sweep, M1) is not yet.
  await c.query(stripBom(fs.readFileSync(path.join(ASSISTANT, '..', 'supabase/migrations', '379_ai_ingest_sweep.sql'), 'utf8')));

  // ---------------------------------------------------------- people, brand
  const ppl = await one(`
    with b as (select id, owner_id from public.brands where status = 'active' order by id limit 1),
         a as (select id, reports_to from public.profiles where role = 'apc' and is_active and deleted_at is null order by id limit 1)
    select (select id from b) brand, (select id from public.profiles where role = 'boss' and is_active and deleted_at is null limit 1) boss,
           (select id from public.profiles where role = 'ol' and is_active and deleted_at is null order by id limit 1) ol,
           (select id from a) apc_a,
           (select p.id from public.profiles p, b, a
             where p.role = 'apc' and p.is_active and p.deleted_at is null and p.id <> a.id
               and a.reports_to is distinct from p.id and not public.can_view_brand(b.owner_id, b.id, p.id)
             order by p.id limit 1) apc_b`);
  for (const k of ['brand', 'boss', 'ol', 'apc_a', 'apc_b']) if (!ppl[k]) throw new Error(`no suitable ${k} on dev`);
  const dev = (await one(`select id from public.profiles where role = 'developer' and is_active and deleted_at is null order by id limit 1`))?.id;
  if (!dev) throw new Error('no active developer on dev');

  // ---------------------------------------------------------- synthetic sources
  const reportData = {
    overallPerformance: { gmv: '1234.50', orders: '42' },
    overallInsights: '<p>QA Zq overall: GMV grew on the back of two hero videos.</p>',
    topCreatorsInsights: '<p>QA Zq creators: creator one posted daily.</p>',
    topVideosInsights: '<p>QA Zq videos: the unboxing format beat tutorials.</p>',
    recommendations: '<p>QA Zq recommendation: brief five new creators on the unboxing angle.</p>',
    upcomingCampaigns: 'QA Zq spring sale on the 12th.',
    topCreators: [{ name: 'qa_creator_one', gmv: '700', videosPosted: '9', itemsSold: '20', notes: '' }],
  };
  const report = (await one(`insert into public.reports (brand_id, author_id, type, period_start, period_end, period_label, status, data)
      values ($1, $2, 'weekly', '2099-01-05', '2099-01-11', 'QA Zq Week 1', 'approved', $3) returning id`, [ppl.brand, ppl.apc_a, reportData])).id;
  const report2 = (await one(`insert into public.reports (brand_id, author_id, type, period_start, period_end, period_label, status, data)
      values ($1, $2, 'weekly', '2099-01-12', '2099-01-18', 'QA Zq Week 2', 'submitted', $3) returning id`, [ppl.brand, ppl.apc_a, reportData])).id;
  const kb = (await one(`insert into public.kb_articles (title, url, category, visibility, approval_status, created_by, version)
      values ('QA Zq SOP: ship samples', 'https://example.com/qa-zq-sop', 'operational_sops', 'office', 'approved', $1, 1) returning id`, [ppl.boss])).id;
  const sop = (await one(`insert into public.ai_assistant_docs (title, content, is_active, kind, kb_article_id)
      values ('QA Zq SOP: ship samples', $1, true, 'doc', $2) returning id`,
      ['QA Zq SOP: ship samples\nStep 1: Pack the zqbox with the sample.\nStep 2: Print the label from the Orders page.\n<!--wurx-sop-import-->', kb])).id;
  const incentive = (await one(`insert into public.incentives (user_id, month, incentives, bonuses) values ($1, '2099-01', $2, $3) returning id`, [ppl.apc_a,
    JSON.stringify([{ id: 'q1', text: 'QA Zq post 30 videos', targetValue: 30, suffix: '', amount: 5000, achievedValue: 3, completed: false }]),
    JSON.stringify([{ id: 'q2', text: 'QA Zq attendance', targetValue: 100, suffix: '%', amount: 2000, source: 'attendance', achievedValue: 0, completed: false }])])).id;

  const ttsRecords = [
    { id: 'qa-tts-1', kind: 'essay', url: 'https://example.com/qa-tts-1', title: 'QA Zq returns policy', breadcrumb: 'Seller > QA', text: 'QA Zq zqreturns: sellers accept returns within 30 days.', views: 5, modified_at: '2099-01-01T00:00:00Z' },
    { id: 'qa-tts-1', kind: 'course_lesson', url: 'https://example.com/qa-course', title: 'QA Zq returns policy', text: 'Lesson copy of the returns article, longer text here.', course: { learning_id: '1', name: 'QA course', lesson_index: 0 } },
    { id: 'qa-tts-2', kind: 'essay', url: 'https://example.com/qa-tts-2', title: 'QA Zq shipping', breadcrumb: 'Seller > QA', text: 'QA Zq zqshipping: labels print from the Orders page.', views: 9 },
    { id: 'qa-tts-3', kind: 'essay', url: 'https://example.com/qa-tts-3', title: 'QA Zq video only', text: '' },
  ];
  const imp1 = await importArticles(c, ttsRecords);
  const imp2 = await importArticles(c, [...ttsRecords].reverse().map((r) => ({ ...r, views: (r.views ?? 0) + 1000 })));
  check('TikTok import 1: 2 inserted, 1 empty skipped, 1 repeated id merged', imp1.inserted === 2 && imp1.skippedEmpty.length === 1 && imp1.duplicateIds === 1, JSON.stringify(imp1));
  check('TikTok import 2 (same file, reordered, new views): writes nothing', imp2.inserted === 0 && imp2.updated === 0 && imp2.unchanged === 2, JSON.stringify(imp2));

  const mine = [['report', report], ['kb_article', kb], ['ai_doc', sop], ['tts_article', 'qa-tts-1'], ['tts_article', 'qa-tts-2'], ['incentive', incentive], ['report', report2]];
  const indexed = mine.filter(([t, id]) => t !== 'ai_doc' && id !== report2);   // report2 joins once approved
  const enqueue = async (list, op = 'upsert') => { for (const [t, id] of list) await q(`select public.ai_enqueue($1, $2, $3, 5)`, [t, String(id), op]); };
  const stat = async () => Object.fromEntries((await q(`select relname, n_tup_ins::int i, n_tup_upd::int u, n_tup_del::int d
      from pg_stat_xact_user_tables where schemaname = 'public' and relname in ('ai_documents','ai_chunks')`)).map((r) => [r.relname, r]));
  const delta = (a, b) => Object.fromEntries(['ai_documents', 'ai_chunks'].map((k) => [k, { i: b[k].i - a[k].i, u: b[k].u - a[k].u, d: b[k].d - a[k].d }]));
  const zero = (d) => Object.values(d).every((x) => !x.i && !x.u && !x.d);
  const run = async (embed = fakeEmbed) => {
    const before = { ...fake };
    const s0 = await stat();
    const s = await runWorker({ rpc, embed, pipelineVersion: pipeline, workerId: `test-${crypto.randomUUID()}` });
    return { s, calls: fake.calls - before.calls, inputs: fake.inputs - before.inputs, d: delta(s0, await stat()) };
  };
  const doc = (t, id) => one(`select d.*, (select count(*)::int from public.ai_chunks c where c.document_id = d.id) rows
      from public.ai_documents d where source_type = $1 and source_id = $2`, [t, String(id)]);

  // ---------------------------------------------------------- run 1 / run 2
  await enqueue(mine);
  const r1 = await run();
  const chunkRows = (await one(`select count(*)::int n from public.ai_chunks c join public.ai_documents d on d.id = c.document_id
      where (d.source_type, d.source_id) in (select * from unnest($1::text[], $2::text[]))`, [indexed.map((x) => x[0]), indexed.map((x) => String(x[1]))])).n;
  check('run 1: 5 documents written; the linked SOP doc and the SUBMITTED (not approved) report are not indexed', r1.s.written === 5 && r1.s.noop === 2 && r1.s.failed === 0 && !(await doc('report', report2)), JSON.stringify({ w: r1.s.written, noop: r1.s.noop, f: r1.s.failed, e: r1.s.errors }));
  check('run 1: one embedding pass, every chunk embedded once', r1.calls === 1 && r1.inputs === chunkRows && r1.s.embedded_chunks === chunkRows, `calls ${r1.calls}, inputs ${r1.inputs}, chunks ${chunkRows}`);
  const kbDoc = await doc('kb_article', kb);
  const kbText = (await q(`select string_agg(content, ' ') t from public.ai_chunks where document_id = $1`, [kbDoc.id]))[0].t;
  check('run 1: the linked SOP text is merged into the KB document, under the KB ACL', /zqbox/.test(kbText) && kbDoc.acl_mode === 'kb' && !(await doc('ai_doc', sop)), kbDoc.acl_mode);
  const incDoc = await doc('incentive', incentive);
  check('run 1: incentive document has ACL incentive, author = the employee, no achieved values', incDoc.acl_mode === 'incentive' && incDoc.author_id === ppl.apc_a && incDoc.rows > 0, incDoc.acl_mode);
  const counts = await q(`select d.source_id, d.chunk_count, count(c.id)::int n from public.ai_documents d left join public.ai_chunks c on c.document_id = d.id
      where d.source_id = any($1) group by 1, 2`, [indexed.map((x) => String(x[1]))]);
  check('run 1: chunk_count equals the chunk rows of every document', counts.length === 5 && counts.every((r) => r.chunk_count === r.n), JSON.stringify(counts.map((r) => [r.chunk_count, r.n])));
  check('run 1: pipeline_version / embed_model / source_fp stored', incDoc.pipeline_version === PIPELINE_VERSION && incDoc.embed_model === MODEL && !!incDoc.source_fp, incDoc.pipeline_version);

  await enqueue(mine);
  const r2 = await run();
  check('run 2 (nothing changed): 0 embedder calls, 0 rows written to ai_documents / ai_chunks', r2.calls === 0 && zero(r2.d), JSON.stringify(r2.d));
  check('run 2: every document skipped as unchanged', r2.s.skipped_unchanged === 5 && r2.s.noop === 2 && r2.s.claimed === 7, JSON.stringify({ skip: r2.s.skipped_unchanged, noop: r2.s.noop }));
  const run2Row = await one(`select skipped_unchanged, embedded_chunks, (stats->>'embed_requests')::int req from public.ai_ingest_runs order by id desc limit 1`);
  check('run 2: ai_ingest_runs row records skipped_unchanged 5, 0 embeds, 0 requests', run2Row.skipped_unchanged === 5 && run2Row.embedded_chunks === 0 && run2Row.req === 0, JSON.stringify(run2Row));

  // ---------------------------------------------------------- one edited insight
  await q(`update public.reports set data = jsonb_set(data, '{topCreatorsInsights}', to_jsonb('<p>QA Zq creators: creator one now posts twice a day.</p>'::text)) where id = $1`, [report]);
  await enqueue([['report', report]]);
  const r3 = await run();
  check('edit one insight: exactly 1 chunk embedded, 1 chunk row + 1 document row updated', r3.inputs === 1 && r3.calls === 1 && r3.d.ai_chunks.u === 1 && r3.d.ai_chunks.i === 0 && r3.d.ai_chunks.d === 0 && r3.d.ai_documents.u === 1, JSON.stringify({ inputs: r3.inputs, d: r3.d }));

  // ---------------------------------------------------------- approve the submitted report
  await q(`update public.reports set status = 'verified' where id = $1`, [report2]);
  await enqueue([['report', report2]]);
  const r4a = await run();
  check('report 2 verified (not approved): still not indexed, 0 embeds', r4a.calls === 0 && zero(r4a.d) && !(await doc('report', report2)), JSON.stringify(r4a.d));
  await q(`update public.reports set status = 'approved' where id = $1`, [report2]);
  await enqueue([['report', report2]]);
  const r4 = await run();
  const rep2 = await doc('report', report2);
  check('report 2 approved → indexed (new document, its chunks embedded)', r4.s.written === 1 && rep2?.status === 'active' && r4.inputs === rep2.rows && rep2.metadata.status === 'approved', JSON.stringify({ w: r4.s.written, inputs: r4.inputs }));
  indexed.push(['report', report2]);

  // ---------------------------------------------------------- search + ACL (before the KB tightening)
  const qv = vecLit(fakeVec('QA Zq query'));
  const searchAs = async (uid, text = 'QA Zq') => {
    await c.query('savepoint srch');
    try {
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
      await c.query('set local role authenticated');
      const rows = await q(`select distinct source_type || ':' || source_id k from public.ai_search($1::extensions.vector, $2, $3::text[], null, null, null, 100, null)`,
        [qv, text, ['report', 'kb_article', 'tts_article', 'incentive', 'ai_doc']]);
      return new Set(rows.map((r) => r.k).filter((k) => mine.some(([t, id]) => k === `${t}:${id}`)));
    } finally { await c.query('rollback to savepoint srch'); }
  };
  const K = { rep: `report:${report}`, rep2: `report:${report2}`, kb: `kb_article:${kb}`, inc: `incentive:${incentive}`, t1: 'tts_article:qa-tts-1', t2: 'tts_article:qa-tts-2' };
  const same = (set, keys) => set.size === keys.length && keys.every((k) => set.has(k));
  const show = (set) => [...set].map((k) => Object.keys(K).find((n) => K[n] === k)).join(',');
  const boss1 = await searchAs(ppl.boss);
  check('ai_search as Boss: all 6 synthetic documents searchable', same(boss1, Object.values(K)), show(boss1));
  const olS = await searchAs(ppl.ol);
  check('ai_search as OL: all 6 (reports, KB, incentives are OL-visible)', same(olS, Object.values(K)), show(olS));
  const apcA1 = await searchAs(ppl.apc_a);
  check('ai_search as the APC author: own reports, own incentive, office KB, TikTok', same(apcA1, Object.values(K)), show(apcA1));
  const apcB1 = await searchAs(ppl.apc_b);
  check('ai_search as another APC: no report of an unseen brand, no one else\'s incentive', same(apcB1, [K.kb, K.t1, K.t2]), show(apcB1));
  const kw = await searchAs(ppl.boss, 'zqshipping');
  check('ai_search keyword arm finds the TikTok article by a rare word', kw.has(K.t2), show(kw));

  // ---------------------------------------------------------- KB visibility (ACL only)
  await q(`update public.kb_articles set visibility = 'role', visible_to_roles = '{ol}' where id = $1`, [kb]);
  await enqueue([['kb_article', kb]], 'acl');
  const r5 = await run();
  const kb2 = await doc('kb_article', kb);
  check('KB visibility office → role {ol}: 0 embeds, 0 chunk writes, ACL + doc_hash updated', r5.calls === 0 && r5.d.ai_chunks.i + r5.d.ai_chunks.u + r5.d.ai_chunks.d === 0 && r5.d.ai_documents.u === 1
    && kb2.acl_roles.join() === 'ol' && kb2.metadata.visibility === 'role' && kb2.doc_hash !== kbDoc.doc_hash, JSON.stringify(r5.d));
  const apcA2 = await searchAs(ppl.apc_a);
  const ol2 = await searchAs(ppl.ol);
  check('after tightening: the APC loses the KB document, the OL keeps it', !apcA2.has(K.kb) && ol2.has(K.kb), `${show(apcA2)} / ${show(ol2)}`);

  // ---------------------------------------------------------- pipeline bump
  await q(`create or replace function public.ai_pipeline_version() returns text language sql stable as $$ select 'qa-bump'::text $$`);
  const cand = async () => (await q(`select op, why, source_id from (
      select * from public.ai_backfill_candidates('report') union all select * from public.ai_backfill_candidates('kb_article')
      union all select * from public.ai_backfill_candidates('tts_article') union all select * from public.ai_backfill_candidates('incentive')) x
      where source_id = any($1)`, [indexed.map((x) => String(x[1]))]));
  const c1 = await cand();
  check('bump: backfill candidates flag all 6 documents as pipeline', c1.length === 6 && c1.every((r) => r.op === 'upsert' && r.why === 'pipeline'), JSON.stringify(c1.map((r) => r.why)));
  pipeline = 'qa-bump';
  await enqueue(mine);
  const r6 = await run();
  check('bump run: every document reprocessed once, 0 embeds (text unchanged)', r6.s.written === 6 && r6.calls === 0 && r6.d.ai_documents.u === 6 && r6.d.ai_chunks.i + r6.d.ai_chunks.d === 0, JSON.stringify({ w: r6.s.written, d: r6.d }));
  await enqueue(mine);
  const r7 = await run();
  const c2 = await cand();
  check('after the bump: idempotent again (0 embeds, 0 writes, no candidates)', r7.calls === 0 && zero(r7.d) && r7.s.skipped_unchanged === 6 && c2.length === 0, JSON.stringify({ d: r7.d, c: c2.length }));

  // ---------------------------------------------------------- reopen → soft delete → re-approve
  await q(`update public.reports set status = 'submitted' where id = $1`, [report]);   // reopened
  await enqueue([['report', report]], 'delete');                                        // what the 374 trigger enqueues
  const r8 = await run();
  const repOpen = await doc('report', report);
  const bossOpen = await searchAs(ppl.boss);
  const apcOpen = await searchAs(ppl.apc_a);
  check('reopened (approved → submitted): soft delete, chunks kept, hidden from ai_search for everyone, 0 embeds',
    r8.s.soft_deleted === 1 && repOpen.status === 'deleted' && repOpen.rows > 0 && !bossOpen.has(K.rep) && !apcOpen.has(K.rep) && bossOpen.has(K.rep2) && r8.calls === 0,
    JSON.stringify({ st: repOpen.status, rows: repOpen.rows }));
  await q(`update public.reports set status = 'draft' where id = $1`, [report]);
  await enqueue([['report', report]]);
  const r8b = await run();
  check('still not approved (→ draft): nothing to do, nothing written', r8b.s.noop === 1 && zero(r8b.d), JSON.stringify(r8b.d));
  await q(`update public.reports set status = 'approved' where id = $1`, [report]);
  await enqueue([['report', report]]);
  const r9 = await run();
  check('re-approved with unchanged text: 0 embeds, 0 chunk writes, document active and searchable again',
    r9.calls === 0 && r9.d.ai_chunks.i + r9.d.ai_chunks.u + r9.d.ai_chunks.d === 0 && (await doc('report', report)).status === 'active' && (await searchAs(ppl.boss)).has(K.rep),
    JSON.stringify(r9.d));

  // ---------------------------------------------------------- incentive progress / verify
  await q(`update public.incentives set incentives = jsonb_set(incentives, '{0,achievedValue}', '29'), verified = true where id = $1`, [incentive]);
  await enqueue([['incentive', incentive]]);
  const r10 = await run();
  const inc2 = await doc('incentive', incentive);
  check('incentive progress + verified: 0 embeds, 0 chunk writes, metadata.verified true', r10.calls === 0 && r10.d.ai_chunks.i + r10.d.ai_chunks.u + r10.d.ai_chunks.d === 0 && inc2.metadata.verified === true, JSON.stringify(r10.d));

  // ---------------------------------------------------------- who may switch a source: the Boss only
  // (RLS ai_config_write → is_ai_admin = boss, mig 207). Runs one statement as
  // `uid`; keep=true keeps its effect in the transaction.
  const asUser = async (uid, sql, params = [], keep = false) => {
    await c.query('savepoint u');
    let res = null, err = null;
    try {
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
      await c.query('set local role authenticated');
      res = await c.query(sql, params);
    } catch (e) { err = e; }
    if (keep && !err) {
      await c.query('release savepoint u');
      await c.query('reset role');
      await c.query(`select set_config('request.jwt.claims', '', true)`);
    } else await c.query('rollback to savepoint u');
    return { rows: res?.rows ?? [], n: res?.rowCount ?? -1, err: err?.message ?? '' };
  };
  const cfgUpd = (uid, set = `ingest_sources = '{}'`) => asUser(uid, `update public.ai_assistant_config set ${set}`).then((r) => r.n);
  const [cfgApc, cfgOl, cfgDev, cfgBoss] = [await cfgUpd(ppl.apc_a), await cfgUpd(ppl.ol), await cfgUpd(dev), await cfgUpd(ppl.boss)];
  check('ingest_sources: an APC, an OL and a Developer cannot change it (0 rows), the Boss can',cfgApc <= 0 && cfgOl <= 0 && cfgDev <= 0 && cfgBoss === 1, `apc ${cfgApc}, ol ${cfgOl}, dev ${cfgDev}, boss ${cfgBoss}`);
  const devPersona = await cfgUpd(dev, `persona = persona || ' qa'`);
  const devModel = await cfgUpd(dev, `model = 'qa/model'`);
  check('a Developer still cannot change the persona or the model (0 rows)', devPersona <= 0 && devModel <= 0, `persona ${devPersona}, model ${devModel}`);

  const conv = (await one(`insert into public.ai_conversations (user_id, title) values ($1, 'QA Zq private chat') returning id`, [ppl.boss])).id;
  await q(`insert into public.ai_messages (conversation_id, role, content) values ($1, 'user', 'QA Zq private message')`, [conv]);
  const devConv = await asUser(dev, `select id from public.ai_conversations where id = $1`, [conv]);
  const devMsg = await asUser(dev, `select id from public.ai_messages where conversation_id = $1`, [conv]);
  const bossConv = await asUser(ppl.boss, `select id from public.ai_conversations where id = $1`, [conv]);
  check('a Developer still cannot read the Boss\'s conversation or its messages (0 rows); the Boss can',
    devConv.rows.length === 0 && !devConv.err && devMsg.rows.length === 0 && !devMsg.err && bossConv.rows.length === 1, `dev ${devConv.rows.length}/${devMsg.rows.length}, boss ${bossConv.rows.length}`);

  // ---------------------------------------------------------- incentive switched OFF (one update, by the Boss), then ON
  const setSources = (sql) => q(`update public.ai_assistant_config set ingest_sources = ${sql}`);
  const bossOffUpd = await asUser(ppl.boss, `update public.ai_assistant_config set ingest_sources = array_remove(ingest_sources, 'incentive')`, [], true);
  check('the Boss switches incentive OFF (1 row)', bossOffUpd.n === 1 && !bossOffUpd.err, bossOffUpd.err || bossOffUpd.n);
  const [bossOff, olOff, apcOff] = [await searchAs(ppl.boss), await searchAs(ppl.ol), await searchAs(ppl.apc_a)];
  check('incentive OFF (one update): its document vanishes from ai_search at once, for the Boss, the OL and the employee',
    !bossOff.has(K.inc) && !olOff.has(K.inc) && !apcOff.has(K.inc) && bossOff.has(K.rep), `${show(bossOff)} / ${show(olOff)} / ${show(apcOff)}`);
  await q(`update public.incentives set verified = false where id = $1`, [incentive]);   // a change while off
  await enqueue([['incentive', incentive]]);
  const rOff = await run();
  const incOffDoc = await doc('incentive', incentive);
  check('incentive OFF: a drain completes the queued item (soft delete, chunks and vectors kept), 0 embeds, 0 failures',
    rOff.s.disabled === 1 && rOff.s.failed === 0 && rOff.calls === 0 && rOff.d.ai_chunks.i + rOff.d.ai_chunks.u + rOff.d.ai_chunks.d === 0
    && incOffDoc.status === 'deleted' && incOffDoc.rows === inc2.rows
    && (await one(`select count(*)::int n from public.ai_ingest_queue where source_type = 'incentive' and status <> 'done'`)).n === 0,
    JSON.stringify({ dis: rOff.s.disabled, f: rOff.s.failed, st: incOffDoc.status, d: rOff.d }));
  const bfOff = (await one(`select public.ai_backfill('incentive') v`)).v;
  const recOff = (await one(`select public.ai_reconcile() v`)).v;
  const candOff = (await one(`select count(*)::int n from public.ai_backfill_candidates('incentive')`)).n;
  const qOff = (await one(`select count(*)::int n from public.ai_ingest_queue where source_type = 'incentive' and status = 'pending'`)).n;
  check('incentive OFF: backfill {} and reconcile enqueue nothing for it; 0 candidates', JSON.stringify(bfOff) === '{}' && !('incentive' in (recOff ?? {})) && candOff === 0 && qOff === 0,
    `backfill ${JSON.stringify(bfOff)}, reconcile keys ${Object.keys(recOff ?? {}).join(',') || 'none'}`);
  await q(`delete from public.ai_ingest_queue where status = 'pending'`);   // reconcile also queued real rows of other types: not ours to drain
  let offWrite = '';
  try { await rpc('ai_ingest_write', { p_doc: { source_type: 'incentive', source_id: 'x', doc_hash: 'h', embed_model: MODEL, acl_mode: 'incentive' }, p_chunks: [] }); } catch (e) { offWrite = e.message; }
  check('incentive OFF: ai_ingest_write refuses it (allow-list)', /not enabled/.test(offWrite), offWrite);
  const statsList = (await one(`select public.ai_ingest_stats()->'ingest_sources' v`)).v;
  check('ai_ingest_stats shows the enabled list (no incentive)', Array.isArray(statsList) && !statsList.includes('incentive') && statsList.includes('report'), JSON.stringify(statsList));
  const bossOnUpd = await asUser(ppl.boss, `update public.ai_assistant_config set ingest_sources = array_append(ingest_sources, 'incentive')`, [], true);
  check('the Boss switches incentive back ON (1 row)', bossOnUpd.n === 1 && !bossOnUpd.err, bossOnUpd.err || bossOnUpd.n);
  const bfOn = (await one(`select public.ai_backfill('incentive') v`)).v;
  // The backfill also queues dev's real plans as 'missing' (the store holds
  // none): drop them undrained, the hold forbids processing real rows.
  const ourItem = await one(`select count(*)::int n from public.ai_ingest_queue where status = 'pending' and source_type = 'incentive' and source_id = $1`, [incentive]);
  await q(`delete from public.ai_ingest_queue where status = 'pending' and not (source_type = 'incentive' and source_id = $1)`, [incentive]);
  await q(`update public.ai_ingest_queue set not_before = now() - interval '1 second' where status = 'pending'`);
  const rOn = await run();
  check('incentive back ON: backfill revives the soft-deleted document; 0 embeds, 0 chunk inserts/deletes (vectors reused); visible again',
    bfOn?.incentive?.revived === 1 && !bfOn?.incentive?.changed && ourItem.n === 1 && rOn.s.written === 1 && rOn.s.claimed === 1 && rOn.calls === 0
    && rOn.d.ai_chunks.i + rOn.d.ai_chunks.d === 0
    && (await doc('incentive', incentive)).status === 'active' && (await searchAs(ppl.boss)).has(K.inc) && (await searchAs(ppl.apc_a)).has(K.inc),
    `${JSON.stringify(bfOn?.incentive?.revived)} w=${rOn.s.written} calls=${rOn.calls} d=${JSON.stringify(rOn.d)}`);
  const again = (await one(`select count(*)::int n from public.ai_backfill_candidates('incentive') where source_id = $1`, [incentive])).n;
  check('incentive back ON: afterwards it is no longer a backfill candidate', again === 0, `${again}`);

  // ---------------------------------------------------------- source DELETE → hard delete
  await q('delete from public.kb_articles where id = $1', [kb]);
  await enqueue([['kb_article', kb]], 'delete');
  await enqueue([['ai_doc', sop]]);
  const r11 = await run();
  const kbGone = await doc('kb_article', kb);
  const orphanChunks = (await one(`select count(*)::int n from public.ai_chunks where document_id = $1`, [kbDoc.id])).n;
  check('KB article deleted: document and chunks gone; its now-unlinked SOP stays unindexed', !kbGone && orphanChunks === 0 && r11.s.deleted === 1 && !(await doc('ai_doc', sop)), JSON.stringify({ del: r11.s.deleted, noop: r11.s.noop }));

  // ---------------------------------------------------------- backfill twice, scoped to the synthetic TikTok ids
  // (tts_articles and the store hold real rows; under the 'qa-bump' pipeline every
  // real document is a candidate too, so its queue rows are dropped undrained.)
  const qaCand = async () => q(`select source_id, why from public.ai_backfill_candidates('tts_article') where source_id like 'qa-tts-%'`);
  const pendingN = async (like = '%') => (await one(`select count(*)::int n from public.ai_ingest_queue where status = 'pending' and source_id like $1`, [like])).n;
  const tc0 = await qaCand();
  const imp3 = await importArticles(c, [{ ...ttsRecords[2], text: 'QA Zq zqshipping: labels print from the Orders page, or from the app.' }]);
  const tc1 = await qaCand();
  await q(`select public.ai_backfill('tts_article')`);
  const [p1, qa1] = [await pendingN(), await pendingN('qa-tts-%')];
  await q(`select public.ai_backfill('tts_article')`);
  const p2 = await pendingN();
  check('backfill with nothing changed: no synthetic TikTok candidate', tc0.length === 0, JSON.stringify(tc0));
  check('one TikTok body changed: the import updates 1, it is the only synthetic candidate, backfill enqueues it, a second backfill nothing',
    imp3.updated === 1 && JSON.stringify(tc1) === JSON.stringify([{ source_id: 'qa-tts-2', why: 'changed' }]) && qa1 === 1 && p2 === p1, `${JSON.stringify(tc1)} qa ${qa1}, pending ${p1} → ${p2}`);
  await q(`delete from public.ai_ingest_queue where status = 'pending' and source_id not like 'qa-tts-%'`);
  // Backfill staggers not_before by +1 ms per item, and now() is frozen inside
  // one transaction: make the item due, as the clock would.
  await q(`update public.ai_ingest_queue set not_before = now() - interval '1 second' where status = 'pending'`);
  const r12 = await run();
  check('drain after the backfill: only the changed article, only its new chunk embedded', r12.s.written === 1 && r12.inputs === 1, JSON.stringify({ w: r12.s.written, inputs: r12.inputs }));
  const tc3 = await qaCand();
  check('backfill after the drain: no synthetic candidate left', tc3.length === 0, JSON.stringify(tc3));

  // ---------------------------------------------------------- lost lock / deny-list
  await enqueue([['report', report]]);
  const [claimed] = await q(`select * from public.ai_ingest_claim(1, 'worker-A')`);
  await q(`update public.ai_ingest_queue set locked_by = 'worker-B' where id = $1`, [claimed.id]);
  const hashBefore = (await doc('report', report)).doc_hash;
  const w = await rpc('ai_ingest_write', { p_doc: { source_type: 'report', source_id: report, doc_hash: 'stale', embed_model: MODEL, acl_mode: 'report', title: 'stale' }, p_chunks: [], p_queue_id: claimed.id, p_worker: 'worker-A' });
  const cpl = await rpc('ai_ingest_complete', { p_id: claimed.id, p_worker: 'worker-A' });
  check('a worker that lost its lock: write refused, document untouched, complete returns false',
    w.ok === false && w.reason === 'lost_lock' && cpl === false && (await doc('report', report)).doc_hash === hashBefore, JSON.stringify(w));
  await q(`update public.ai_ingest_queue set status = 'done' where id = $1`, [claimed.id]);
  const refused = [];
  for (const t of ['salary_history', 'employee_compensation', 'payroll', 'basic_salary', 'attendance', 'leave_requests', 'performance_ratings', 'qa_not_enabled']) {
    try { await rpc('ai_ingest_write', { p_doc: { source_type: t, source_id: 'x', doc_hash: 'h', embed_model: MODEL, acl_mode: 'boss' }, p_chunks: [] }); }
    catch (e) { if (/not enabled|never indexed/.test(e.message)) refused.push(t); }
  }
  check('ai_ingest_write refuses every type outside the allow-list (employee_compensation, payroll, basic_salary, …)', refused.length === 8, refused.join(','));
  // Even if the Boss enabled one by mistake: once mig 380 is on dev the save
  // itself is refused (M1-b); behind that, ai_source_types() ignores an unknown
  // name (mig 379, M1), and the unanchored deny-list in ai_ingest_write stays behind it.
  const has380 = (await one(`select count(*)::int n from pg_trigger where tgname = 'ai_assistant_config_sources_check'`)).n > 0;
  if (has380) {
    await c.query('savepoint m1b');
    const code = await setSources(`array_append(ingest_sources, 'employee_compensation')`).then(() => 'accepted', (e) => e.code);
    await c.query('rollback to savepoint m1b');
    check('380 (M1-b): saving employee_compensation into ingest_sources is refused', code === '23514', code);
    await q(`alter table public.ai_assistant_config disable trigger ai_assistant_config_sources_check`);
  }
  await setSources(`array_append(ingest_sources, 'employee_compensation')`);
  if (has380) await q(`alter table public.ai_assistant_config enable trigger ai_assistant_config_sources_check`);
  let net2 = '';
  try { await rpc('ai_ingest_write', { p_doc: { source_type: 'employee_compensation', source_id: 'x', doc_hash: 'h', embed_model: MODEL, acl_mode: 'boss' }, p_chunks: [] }); } catch (e) { net2 = e.message; }
  const ignored = (await one(`select public.ai_ingest_stats()->'ignored_sources' v`)).v;
  check('employee_compensation refused even when enabled by mistake (ignored as unknown, shown in ignored_sources)',
    /not enabled|never indexed/.test(net2) && JSON.stringify(ignored) === '["employee_compensation"]', `${net2} / ${JSON.stringify(ignored)}`);
  await setSources(`array_remove(ingest_sources, 'employee_compensation')`);

  // ---------------------------------------------------------- the real embedder, 3 tiny texts
  if (REAL) {
    const key = readEnv().OPEN_AI_API_KEY;
    if (!key) throw new Error('OPEN_AI_API_KEY missing in ../.env.dev');
    const realRecs = [
      { id: 'qa-real-1', kind: 'essay', url: 'https://example.com/r1', title: 'Refund window', text: 'Refunds must be requested within 30 days.' },
      { id: 'qa-real-2', kind: 'essay', url: 'https://example.com/r2', title: 'Labels', text: 'Shipping labels print from the Orders page.' },
      { id: 'qa-real-3', kind: 'essay', url: 'https://example.com/r3', title: 'Commission', text: 'Creators earn commission on affiliate sales.' },
    ];
    await importArticles(c, realRecs);
    await enqueue(realRecs.map((r) => ['tts_article', r.id]));
    const real = await runWorker({ rpc, embed: openAiEmbedder(key), pipelineVersion: pipeline, workerId: 'test-real' });
    // One batch; more than one request only if the network made it retry.
    check('real embedder: 3 texts in one batch, < 200 tokens', real.embedded_chunks === 3 && real.embed_calls === 1 && real.embed_requests >= 1 && real.embed_requests <= 5 && real.embed_tokens > 0 && real.embed_tokens < 200, JSON.stringify({ n: real.embedded_chunks, req: real.embed_requests, tok: real.embed_tokens }));
    const qvec = (await openAiEmbedder(key)(['how many days do I have to ask for my money back'])).vectors[0];
    await c.query('savepoint real');
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: ppl.boss, role: 'authenticated' })]);
    await c.query('set local role authenticated');
    const hits = await q(`select source_id from public.ai_search($1::extensions.vector, null, array['tts_article'], null, null, null, 10, null) where source_id like 'qa-real-%'`, [vecLit(qvec)]);
    await c.query('rollback to savepoint real');
    check('real embedder: semantic search ranks the refund article first', hits[0]?.source_id === 'qa-real-1', hits.map((h) => h.source_id).join(','));
  }

  const real = await one(`select count(*)::int n, md5(string_agg(id::text || doc_hash || status, ',' order by id)) h from public.ai_documents
      where not (source_id = any($1) or source_id like 'qa-%')`, [mine.map(([, id]) => String(id))]);
  check('the real ai_documents are untouched (same count and hash as before, synthetic rows aside)', real.n === docs0.n && real.h === docs0.h, `${real.n} vs ${docs0.n}`);
} catch (e) {
  check(`test aborted: ${e.message}`, false, e.stack?.split('\n')[1] ?? '');
} finally {
  let intact = false;
  try { intact = (await one('select pg_current_xact_id()::text as x')).x === xid; } catch { intact = true; }
  await c.query('rollback').catch(() => {});
  await c.end().catch(() => {});
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? `  [${r.detail}]` : ''}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed. ${intact ? '(rolled back: nothing was committed)' : '!!! transaction id changed: something may have been COMMITTED'}`);
  process.exitCode = failed || !intact ? 1 : 0;
}
