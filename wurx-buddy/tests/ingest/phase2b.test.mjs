// ============================================================
// QA Phase 2B acceptance harness (qa/2026-09-28-phase2b-test-plan.md), mode H:
// the REAL worker core, extractors, chunker and write RPCs against the dev
// database, inside ONE transaction that is ALWAYS rolled back.
//
//   node --experimental-strip-types tests/ingest/phase2b.test.mjs
//
// Ingestion hold (TEAM rule 8): only synthetic rows (QA Zq …, qa-* ids, 2099
// periods) are written, only inside this transaction; the runner proves at the
// end that its transaction id never changed. The embedder is the REAL
// embedTexts batching code with a counting fake fetch (no OpenAI call).
// Real rows are only read (T9-A counts, T11-C in-memory scan, counts only).
// ============================================================
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { ASSISTANT, devDbUrl, SSL } from '../../scripts/dev-env.mjs';
import { chunkDocument } from '../../../supabase/functions/_shared/ai/chunker.ts';
import { chunkParamsFor, DEFAULT_CONFIG, PIPELINE_VERSION, pipelineSalt } from '../../../supabase/functions/_shared/ai/config.ts';
import { extractors } from '../../../supabase/functions/_shared/ai/extractors/index.ts';
import { pkr } from '../../../supabase/functions/_shared/ai/extractors/incentive.ts';
import { pgRpc } from '../../../supabase/functions/_shared/ai/ingest/db.ts';
import { loaders } from '../../../supabase/functions/_shared/ai/ingest/loaders.ts';
import { crawlToRows, importArticles } from '../../../supabase/functions/_shared/ai/ingest/ttsImport.ts';
import { openAiEmbedder, runWorker } from '../../../supabase/functions/_shared/ai/ingest/worker.ts';
import * as FX from '../../../supabase/functions/_shared/ai/__tests__/fixtures/reports.ts';

const MODEL = DEFAULT_CONFIG.EMBED_MODEL;
const results = [];
let section = '';
const T = (name) => { section = name; };
const check = (name, ok, detail = '') => results.push({ ok: !!ok, name: `${section} ${name}`, detail: String(detail ?? '').slice(0, 220) });
const J = (x) => JSON.stringify(x);

// ── fake OpenAI endpoint behind the REAL embedTexts batching ─────────────
function fakeVec(text) {
  const h = crypto.createHash('sha256').update(text).digest();
  let s = h.readUInt32LE(0) || 1;
  const v = new Array(DEFAULT_CONFIG.EMBED_DIMS);
  let n = 0;
  for (let i = 0; i < v.length; i++) { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; v[i] = s / 4294967296 - 0.5; n += v[i] * v[i]; }
  n = Math.sqrt(n);
  return v.map((x) => Math.round((x / n) * 1e6) / 1e6);
}
const net = { requests: 0, inputs: 0, maxBatch: 0, texts: [] };
const mockFetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  net.requests++; net.inputs += body.input.length; net.maxBatch = Math.max(net.maxBatch, body.input.length); net.texts.push(...body.input);
  const tok = body.input.reduce((a, t) => a + Math.ceil(t.length / 4), 0);
  return new Response(J({ data: body.input.map((t, index) => ({ index, embedding: fakeVec(t) })), usage: { prompt_tokens: tok, total_tokens: tok } }),
    { status: 200, headers: { 'content-type': 'application/json' } });
};
const embedFor = (model = MODEL) => openAiEmbedder('qa-fake-key-not-a-secret', model, mockFetch);
const vecLit = (v) => `[${v.join(',')}]`;

// ── qa_test: pure synthetic source (text lives in memory, no source table) ─
const qaDocs = new Map();   // id → { active, sections, header }
const qaExtractor = {
  sourceType: 'qa_test',
  indexable: (row) => row.active !== false,
  skipReason: (row) => (row.active !== false ? null : 'inactive'),
  toDocument: (row) => {
    if (row.boom) throw new Error('qa poison extractor');
    return { title: `QA Zq ${row.id}`, acl: { mode: 'all' }, metadata: { qa: true }, header: row.header ?? `[QA Zq doc ${row.id}]`, sections: row.sections };
  },
};
const qaSource = {
  extractor: qaExtractor,
  fetch: async (ids) => ids.filter((id) => qaDocs.has(id)).map((id) => {
    const row = { id, ...qaDocs.get(id) };
    return { source_id: id, indexable: row.active !== false, fp: crypto.createHash('md5').update(J(row)).digest('hex'), payload: { row, ctx: undefined } };
  }),
};
const para = (seed, n) => Array.from({ length: n }, (_, i) => `QA Zq ${seed} paragraph ${i}: ${`lorem ${seed} ipsum ${i} dolor sit amet `.repeat(9).trim()}.`).join('\n\n');

// ─────────────────────────────────────────────────────────────────────────
const c = new pg.Client({ connectionString: devDbUrl(), ssl: SSL, connectionTimeoutMillis: 20_000, query_timeout: 240_000 });
c.on('error', () => {});
await c.connect();
const q = async (sql, params) => (await c.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
const rpc = pgRpc(c, { savepoints: true });
const t0 = Date.now();

let xid = null;
try {
  await c.query('begin');
  xid = (await one('select pg_current_xact_id()::text as x')).x;
  await c.query(`set local lock_timeout = '10s'`);
  // If the link drops, the pooler can keep this transaction open with its locks
  // (seen 2026-09-29: 513 locks blocking every other run). Let the server end it.
  await c.query(`set local idle_in_transaction_session_timeout = '5min'`);

  T('PRE');
  // 2026-09-29: the auto-ingestion package (379 save-time check needs 380) runs
  // inside this transaction when dev does not have it yet.
  const appliedMigs = new Set((await q(`select version from supabase_migrations.schema_migrations`)).map((r) => r.version));
  for (const v of ['379', '380']) {
    if (appliedMigs.has(v)) continue;
    const f = fs.readdirSync(path.join(ASSISTANT, '..', 'supabase/migrations')).find((n) => n.startsWith(`${v}_`));
    await c.query(fs.readFileSync(path.join(ASSISTANT, '..', 'supabase/migrations', f), 'utf8').replace(/^﻿/, ''));
  }
  const pre = await one(`select (select count(*)::int from ai_documents) d, (select count(*)::int from ai_chunks) ch,
      (select count(*)::int from tts_articles) t, (select count(*)::int from ai_ingest_queue where status in ('pending','processing')) qb`);
  if (pre.qb) throw new Error(`refusing: the dev queue is busy ${J(pre)}`);
  // Since the first ingestion (2026-09-29) dev holds a real store. This harness
  // needs the Phase-2B starting point (empty store), so the store is set aside
  // IN THIS TRANSACTION ONLY (rolled back at the end, like everything else).
  if (pre.d || pre.ch || pre.t) {
    await q(`delete from ai_chunks where true`);
    await q(`delete from ai_documents where true`);
    await q(`delete from ai_ingest_queue where true`);
    await q(`delete from tts_articles where true`);
    check(`real store set aside in this transaction only (${pre.d} documents, ${pre.ch} chunks, ${pre.t} TikTok rows)`, true);
  }
  const pre2 = await one(`select (select count(*)::int from ai_documents) d, (select count(*)::int from ai_chunks) ch,
      (select count(*)::int from tts_articles) t, (select count(*)::int from ai_ingest_queue where status in ('pending','processing')) qb`);
  check('store empty, queue idle, no TikTok rows (the Phase-2B starting point)', !pre2.d && !pre2.ch && !pre2.t && !pre2.qb, J(pre2));
  check('code PIPELINE_VERSION = ai_pipeline_version() and model = ai_embed_model()',
    (await one('select ai_pipeline_version() v')).v === PIPELINE_VERSION && (await one('select ai_embed_model() v')).v === MODEL);

  // ── T9-A: real backfill candidates, counts only, twice (read-only) ─────
  T('T9-A');
  const candCounts = async () => Object.fromEntries((await q(`select t, count(*)::int n, count(*) filter (where op <> 'upsert' or why <> 'missing')::int other
      from unnest(ai_source_types()) t, lateral ai_backfill_candidates(t) group by t order by t`)).map((r) => [r.t, r]));
  const ca = await candCounts(), cb = await candCounts();
  check('ai_backfill_candidates twice: identical counts per type', J(ca) === J(cb), J(Object.fromEntries(Object.entries(ca).map(([k, v]) => [k, v.n]))));
  const truth = await one(`select
      (select count(*)::int from reports where status = 'approved') report,
      (select count(*)::int from (select k.id, row_number() over (partition by coalesce(k.sop_group_id, k.id) order by k.version desc nulls last, k.id) rn
                                    from kb_articles k where k.approval_status = 'approved') x where rn = 1
          and not exists (select 1 from ai_excluded_documents e where e.source_type = 'kb_article' and e.source_id = x.id::text)) kb_article,   -- mig 380
      (select count(*)::int from ai_assistant_docs where kind = 'doc' and is_active and kb_article_id is null and strpos(content, '<!--wurx-sop-import-->') = 0) ai_doc,
      (select count(*)::int from ai_assistant_docs where kind = 'app_guide' and is_active and kb_article_id is null and strpos(content, '<!--wurx-sop-import-->') = 0) app_guide,
      (select count(*)::int from tts_articles where is_active) tts_article,
      (select count(*)::int from incentives i where
         (select count(*) from jsonb_array_elements(case when jsonb_typeof(i.incentives) = 'array' then i.incentives else '[]' end) e where jsonb_typeof(e) = 'object')
       + (select count(*) from jsonb_array_elements(case when jsonb_typeof(i.bonuses) = 'array' then i.bonuses else '[]' end) e where jsonb_typeof(e) = 'object') > 0) incentive,
      (select count(*)::int from reports where status <> 'approved') report_not_approved`);
  for (const t of ['report', 'kb_article', 'ai_doc', 'app_guide', 'tts_article', 'incentive']) {
    const got = ca[t]?.n ?? 0;
    check(`${t}: candidates = independent count of indexable rows, all 'upsert:missing'`, got === truth[t] && !(ca[t]?.other), `${got} vs ${truth[t]}`);
  }
  check(`reports: the ${truth.report_not_approved} non-approved reports are not candidates (approved only)`, (ca.report?.n ?? 0) === truth.report);
  const queued = await one(`select count(*)::int n from ai_ingest_queue`);
  check('candidates are read-only: 0 queue rows', queued.n === 0, queued.n);

  // Mig 377: only types in ai_assistant_config.ingest_sources may be written or
  // searched. The synthetic qa_test type is switched on AFTER T9-A (it has no
  // SQL source, so ai_backfill_candidates over ai_source_types() would raise).
  const defaultSources = (await one(`select ingest_sources v from ai_assistant_config where id = 1`)).v;
  check('377: default ingest_sources = the 6 real sources', J([...defaultSources].sort()) === J(['ai_doc', 'app_guide', 'incentive', 'kb_article', 'report', 'tts_article']), J(defaultSources));
  await q(`update ai_assistant_config set ingest_sources = ingest_sources || '{qa_test}' where id = 1`);

  // ── people and a synthetic brand ──────────────────────────────────────
  const P = await one(`
    with a as (select id, reports_to from profiles where role = 'apc' and is_active and deleted_at is null and reports_to is not null order by id limit 1)
    select (select id from profiles where role = 'boss' and is_active and deleted_at is null limit 1) boss,
           (select id from profiles where role = 'ol' and is_active and deleted_at is null order by id limit 1) ol,
           (select id from a) apc_a, (select reports_to from a) mgr,
           (select role from profiles where id = (select reports_to from a)) mgr_role,
           (select id from profiles where role = 'developer' and is_active and deleted_at is null order by id limit 1) dev,
           (select id from profiles where role = 'tl' and is_active and deleted_at is null and id <> (select reports_to from a) order by id limit 1) tl_other,
           (select id from profiles where role = 'tl' and is_active and deleted_at is null order by id desc limit 1) tl_owner`);
  const brand = (await one(`insert into brands (brand_name, client_name, owner_id, status, currency) values ('QA Zq Brand', 'QA Zq Client', $1, 'active', 'USD') returning id`, [P.tl_owner])).id;
  const brand2 = (await one(`insert into brands (brand_name, client_name, owner_id, status, currency) values ('QA Zq Other', 'QA Zq Other Client', $1, 'active', 'USD') returning id`, [P.tl_owner])).id;
  const P2 = await one(`select (select p.id from profiles p where p.role = 'apc' and p.is_active and p.deleted_at is null and p.id <> $1 and p.id <> $2
                                 and not public.can_view_brand((select owner_id from brands where id = $3), $3, p.id) order by p.id limit 1) apc_b`, [P.apc_a, P.mgr, brand]);
  Object.assign(P, P2);
  for (const k of ['boss', 'ol', 'apc_a', 'mgr', 'dev', 'tl_other', 'tl_owner', 'apc_b']) if (!P[k]) throw new Error(`no suitable ${k} on dev`);
  const roleOf = Object.fromEntries((await q(`select id, role from profiles where id = any($1)`, [Object.values(P).filter((x) => /^[0-9a-f-]{36}$/.test(String(x)))])).map((r) => [r.id, r.role]));

  // ── synthetic sources in real tables ─────────────────────────────────
  const newReport = async (fx, over = {}) => {
    const r = { ...fx(), ...over };
    return (await one(`insert into reports (brand_id, author_id, type, period_start, period_end, period_label, status, data, sections_enabled, legacy_id)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
      [over.brand_id ?? brand, P.apc_a, r.type, over.ps ?? r.period_start.replace(/^2026/, '2099'), over.pe ?? r.period_end.replace(/^2026/, '2099'), `QA Zq ${r.period_label}`,
       over.status ?? 'approved', J(r.data), J(r.sections_enabled ?? {}), r.legacy_id ? `qa-${r.legacy_id}` : null])).id;
  };
  const R = {
    single: await newReport(FX.weeklySingle), legacy: await newReport(FX.weeklyLegacy, { ps: '2099-03-23', pe: '2099-03-29' }), biweekly: await newReport(FX.biweekly),
    monthly: await newReport(FX.monthly), generic: await newReport(FX.generic, { ps: '2099-04-06', pe: '2099-04-12' }),
    other: await newReport(FX.weeklySingle, { brand_id: brand2 }),
    draft: await newReport(FX.weeklyLegacy, { status: 'draft', ps: '2099-04-13', pe: '2099-04-19' }),
    submitted: await newReport(FX.biweekly, { status: 'submitted', ps: '2099-04-20', pe: '2099-05-03' }),
  };
  const kb = async (title, vis, roles, users, body, url = 'https://example.com/qa-kb') => (await one(`insert into kb_articles (title, body, url, category, visibility, visible_to_roles, visible_to_users, approval_status, created_by, version)
      values ($1, $2, $3, 'operational_sops', $4, $5, $6, 'approved', $7, 1) returning id`, [title, body ?? '', url, vis, roles ?? [], users ?? [], P.boss])).id;
  const K = {
    office: await kb('QA Zq KB office zqacloffice', 'office', null, null, '<p>QA Zq office body zqacloffice. Pack the sample.</p>'),
    tl: await kb('QA Zq KB tl zqacltl', 'role', ['tl'], null, null),
    users: await kb('QA Zq KB users zqaclusers', 'users', null, [P.apc_a], '<p>zqaclusers body</p>'),
    priv: await kb('QA Zq KB private zqaclpriv', 'private', null, null, '<p>zqaclpriv body</p>'),
    olsop: await kb('QA Zq KB ol with SOP zqaclolsop', 'role', ['ol'], null, null),
    sopB: await kb('QA Zq KB sop target B zqaclsopb', 'office', null, null, null),
  };
  const aidoc = async (title, content, kind, kbId = null, meta = null) => (await one(`insert into ai_assistant_docs (title, content, is_active, kind, kb_article_id, meta, slug)
      values ($1, $2, true, $3, $4, $5, $6) returning id`, [title, content, kind, kbId, J(meta ?? {}),`qa-${crypto.randomUUID().slice(0, 8)}`])).id;
  const D = {
    sop: await aidoc('QA Zq SOP linked', 'QA Zq SOP step one zqsoplinked: open the Orders page.\nStep two: print the zqsoplinked label.\n<!--wurx-sop-import-->', 'doc', K.olsop),
    orphanSop: await aidoc('QA Zq SOP orphan', 'zqaclorphan secret SOP text.\n<!--wurx-sop-import-->', 'doc'),
    curated: await aidoc('QA Zq curated zqaclcurated', 'QA Zq curated guide zqaclcurated: how to use the dashboard.', 'doc'),
    guideOl: await aidoc('QA Zq guide ol zqaclguideol', '---\nroles: [ol]\n---\n## Overview\nzqaclguideol only OLs.', 'app_guide', null, { roles: ['ol'], route: '/qa-ol' }),
    guidePay: await aidoc('QA Zq guide salaries zqaclguidepay', '## Salaries\nzqaclguidepay boss only.', 'app_guide', null, { roles: ['boss'], route: '/salaries' }),
  };
  const tts = [
    { id: 'qa-tts-1', kind: 'essay', url: 'https://example.com/qa-tts-1', title: 'QA Zq returns zqacltts', breadcrumb: 'Seller > QA', text: 'QA Zq zqacltts: sellers accept returns within 30 days.', views: 5, modified_at: '2099-01-01T00:00:00Z' },
    { id: 'qa-tts-2', kind: 'essay', url: 'https://example.com/qa-tts-2', title: 'QA Zq shipping', breadcrumb: 'Seller > QA', text: 'QA Zq zqshipping: labels print from the Orders page.\nSecond line about zqshipping carriers.', views: 9 },
  ];
  const imp1 = await importArticles(c, tts);
  const incentive = (await one(`insert into incentives (user_id, month, basic_salary, incentives, bonuses) values ($1, '2099-01', 7777777.77, $2, $3) returning id`, [P.apc_a,
    J([{ id: 'q1', text: 'QA Zq zqaclinc post 30 videos', targetValue: 30, suffix: '', amount: 5000, achievedValue: 987654321, completed: true, completedAt: '2099-01-20', completedBy: P.mgr }]),
    J([{ id: 'q2', text: 'QA Zq zqaclinc attendance', targetValue: 100, suffix: '%', amount: 2000, source: 'attendance', achievedValue: 55555, completed: false },
       { id: 'q3', text: 'QA Zq zqaclinc commission', targetValue: 10000, source: 'commission_tier', brandId: brand, commissionPct: 2, amount: 4444444, achievedValue: 3333333 }])])).id;

  // qa_test corpus
  qaDocs.set('qa-one', { sections: [{ key: 'b', title: 'Body', kind: 'prose', text: 'QA Zq single chunk zqone.' }] });
  qaDocs.set('qa-prose3', { sections: [{ key: 'p', title: 'Prose', kind: 'prose', text: para('zqprose', 12) }] });
  qaDocs.set('qa-table13', { sections: [{ key: 't', title: 'Table', kind: 'table', text: Array.from({ length: 13 }, (_, i) => `row ${i} | zqtable | ${i * 7}`).join('\n') }] });
  qaDocs.set('qa-big45', { sections: [{ key: 't', title: 'Big', kind: 'table', text: Array.from({ length: 45 * 12 }, (_, i) => `big row ${i} | zqbig | value ${i}`).join('\n') }] });
  qaDocs.set('qa-empty', { sections: [] });
  qaDocs.set('qa-unicode', { sections: [{ key: 'u', title: 'Ünïcödé', kind: 'prose', text: 'ذوق 日本語 🚀 zqunicode <b>bold</b> &amp; “quotes” — dash' }] });
  const sources = { qa_test: qaSource };

  const all = [
    ...Object.values(R).map((id) => ['report', id]), ...Object.values(K).map((id) => ['kb_article', id]),
    ['ai_doc', D.sop], ['ai_doc', D.orphanSop], ['ai_doc', D.curated], ['app_guide', D.guideOl], ['app_guide', D.guidePay],
    ['tts_article', 'qa-tts-1'], ['tts_article', 'qa-tts-2'], ['incentive', incentive],
    ...[...qaDocs.keys()].map((id) => ['qa_test', id]),
  ].map(([t, id]) => [t, String(id)]);
  const mineIds = all.map((x) => x[1]);
  // Ingestion hold (Lead, 2026-09-29): the worker may only ever see synthetic
  // items. Before every pass, any pending item that is not ours is removed
  // (inside this transaction) and counted; the count must stay 0.
  const synth = new Set(mineIds);
  let foreignRemoved = 0;

  // ── helpers ──────────────────────────────────────────────────────────
  const enqueue = async (list, op = 'upsert', prio = 5) => { for (const [t, id] of list) await q(`select ai_enqueue($1, $2, $3, $4)`, [t, String(id), op, prio]); };
  const stat = async () => Object.fromEntries((await q(`select relname, n_tup_ins::int i, n_tup_upd::int u, n_tup_del::int d
      from pg_stat_xact_user_tables where relname in ('ai_documents','ai_chunks','tts_articles')`)).map((r) => [r.relname, r]));
  const delta = (a, b) => Object.fromEntries(Object.keys(b).map((k) => [k, { i: b[k].i - (a[k]?.i ?? 0), u: b[k].u - (a[k]?.u ?? 0), d: b[k].d - (a[k]?.d ?? 0) }]));
  const zeroStore = (d) => ['ai_documents', 'ai_chunks'].every((k) => !d[k]?.i && !d[k]?.u && !d[k]?.d);
  const snap = async () => new Map((await q(`
      select 'd:' || d.id k, d.ctid::text c, d.doc_hash e from ai_documents d where d.source_id = any($1)
      union all select 'c:' || c.id, c.ctid::text, md5(c.embedding::text) from ai_chunks c join ai_documents d on d.id = c.document_id where d.source_id = any($1)`, [mineIds])).map((r) => [r.k, r]));
  const moved = (a, b) => [...a].filter(([k, v]) => b.get(k)?.c !== v.c).map(([k]) => k);
  let pipeline = PIPELINE_VERSION;
  let model = MODEL;
  const run = async (o = {}) => {
    foreignRemoved += (await q(`delete from ai_ingest_queue where status in ('pending','processing')
        and not (source_id = any($1) or source_id like 'qa-%') returning id`, [[...synth]])).length;
    const n0 = { ...net, texts: net.texts.length }; const s0 = await stat();
    const s = await runWorker({ rpc: o.rpc ?? rpc, embed: embedFor(model), pipelineVersion: pipeline, model, workerId: o.worker ?? `qa-${crypto.randomUUID()}`, sources, claimBatch: o.batch, checkPipeline: o.checkPipeline });
    return { s, req: net.requests - n0.requests, inputs: net.inputs - n0.inputs, texts: net.texts.slice(n0.texts), d: delta(s0, await stat()) };
  };
  const drain = async (o) => { const agg = []; for (let i = 0; i < 20; i++) { const r = await run(o); agg.push(r); if (!r.s.claimed) break; } return {
    s: agg.reduce((a, r) => { for (const [k, v] of Object.entries(r.s)) if (typeof v === 'number') a[k] = (a[k] ?? 0) + v; return a; }, {}),
    req: agg.reduce((a, r) => a + r.req, 0), inputs: agg.reduce((a, r) => a + r.inputs, 0), texts: agg.flatMap((r) => r.texts),
    d: agg.reduce((a, r) => { for (const [k, v] of Object.entries(r.d)) { a[k] ??= { i: 0, u: 0, d: 0 }; a[k].i += v.i; a[k].u += v.u; a[k].d += v.d; } return a; }, {}) }; };
  const doc = (t, id) => one(`select d.*, (select count(*)::int from ai_chunks c where c.document_id = d.id) nrows from ai_documents d where source_type = $1 and source_id = $2`, [t, String(id)]);
  const chunks = async (t, id) => q(`select c.chunk_index, c.section, c.content, c.content_hash, c.embedding_model, c.ctid::text ct, md5(c.embedding::text) em
      from ai_chunks c join ai_documents d on d.id = c.document_id where d.source_type = $1 and d.source_id = $2 order by c.chunk_index`, [t, String(id)]);
  const searchAs = async (uid, text, opts = {}) => {
    await c.query('savepoint srch');
    try {
      if (opts.service) {
        await c.query(`select set_config('request.jwt.claims', $1, true)`, [J({ role: 'service_role' })]);
        await c.query('set local role service_role');
      } else {
        await c.query(`select set_config('request.jwt.claims', $1, true)`, [J({ sub: uid, role: 'authenticated' })]);
        await c.query('set local role authenticated');
      }
      return await q(`select source_type, source_id, chunk_id, score, content from ai_search($1::extensions.vector, $2, null, null, null, null, 100, $3)`,
        [opts.vec ?? null, text, opts.asUser ?? null]);
    } finally { await c.query('rollback to savepoint srch'); }
  };
  const bossSearchSig = async () => J((await searchAs(P.boss, 'QA Zq zqshipping zqone zqprose zqtable', { vec: vecLit(fakeVec('QA Zq query')) })).map((r) => [r.chunk_id, Number(r.score).toFixed(9)]));

  // ── T1: run 1 → run 2 → run 3 ────────────────────────────────────────
  T('T1');
  check('TikTok import 1: 2 inserted', imp1.inserted === 2, J(imp1));
  await enqueue(all);
  const r1 = await drain({ batch: 20 });
  const docRows = await q(`select d.source_type, d.source_id, d.chunk_count, count(c.id)::int n, count(distinct c.chunk_index)::int ni, d.status
      from ai_documents d left join ai_chunks c on c.document_id = d.id where d.source_id = any($1) group by 1, 2, 3, 6`, [mineIds]);
  const expectIndexed = all.filter(([t, id]) => !(t === 'ai_doc' && (id === String(D.sop) || id === String(D.orphanSop))) && id !== String(R.draft) && id !== String(R.submitted));
  const chunkTotal = docRows.reduce((a, r) => a + r.n, 0);
  check(`run 1: ${expectIndexed.length} documents written, 0 failed; linked + orphan SOP, draft and submitted report not indexed`,
    r1.s.written === expectIndexed.length && !r1.s.failed && docRows.length === expectIndexed.length
    && !docRows.some((r) => [String(D.sop), String(D.orphanSop), String(R.draft), String(R.submitted)].includes(r.source_id)), J({ w: r1.s.written, f: r1.s.failed, docs: docRows.length, err: r1.s.errors }));
  check('run 1: every chunk embedded exactly once (inputs = distinct chunk texts), batches ≤ 96 inputs',
    r1.inputs === new Set(r1.texts).size && r1.inputs <= chunkTotal && net.maxBatch <= 96, `inputs ${r1.inputs}, distinct ${new Set(r1.texts).size}, chunks ${chunkTotal}, max batch ${net.maxBatch}`);
  check('run 1: chunk_count = chunk rows, no duplicate (document, chunk_index)', docRows.every((r) => r.chunk_count === r.n && r.n === r.ni), J(docRows.filter((r) => r.chunk_count !== r.n)));
  check('run 1: 45-chunk doc capped at MAX_CHUNKS_PER_DOC (40)', docRows.find((r) => r.source_id === 'qa-big45')?.n === 40, docRows.find((r) => r.source_id === 'qa-big45')?.n);
  check('run 1: empty doc stored with 0 chunks; unicode doc 1 chunk', docRows.find((r) => r.source_id === 'qa-empty')?.n === 0 && docRows.find((r) => r.source_id === 'qa-unicode')?.n === 1);
  const runRow1 = await one(`select claimed, succeeded, embedded_chunks, (stats->>'embed_requests')::int req from ai_ingest_runs where claimed > 0 order by id desc limit 1`);
  check('ai_ingest_runs records claimed / embedded_chunks / stats.embed_requests (R6)', runRow1.claimed > 0 && runRow1.embedded_chunks === r1.s.embedded_chunks && runRow1.req === r1.req, J(runRow1));

  const snapA = await snap();
  const sigA = await bossSearchSig();
  for (const k of [2, 3]) {
    await enqueue(all, 'upsert', 9);
    const rk = await drain();
    const snapB = await snap();
    check(`run ${k} (nothing changed): 0 HTTP requests, 0 embedded, 0 tokens`, rk.req === 0 && rk.s.embedded_chunks === 0 && rk.s.embed_tokens === 0, J({ req: rk.req, e: rk.s.embedded_chunks }));
    check(`run ${k}: ai_documents / ai_chunks ins/upd/del = 0/0/0 and no row's ctid changed`, zeroStore(rk.d) && moved(snapA, snapB).length === 0, J(rk.d) + ` moved ${moved(snapA, snapB).length}`);
    check(`run ${k}: skipped_unchanged = ${expectIndexed.length}, noop = 4, failed 0`, rk.s.skipped_unchanged === expectIndexed.length && rk.s.noop === 4 && !rk.s.failed, J({ sk: rk.s.skipped_unchanged, noop: rk.s.noop, f: rk.s.failed }));
    check(`run ${k}: ai_search (boss) returns the same chunk ids and scores`, (await bossSearchSig()) === sigA);
  }
  check('queue: every item done, none failed/processing', (await one(`select count(*) filter (where status <> 'done')::int n from ai_ingest_queue`)).n === 0);

  // ── T2: edits → only changed chunks ──────────────────────────────────
  T('T2-A');
  const legacyBefore = await chunks('report', R.legacy);
  await q(`update reports set data = jsonb_set(data, '{overallInsights}', to_jsonb('<p>Slow week after the holiday, zqedited.</p>'::text)) where id = $1`, [R.legacy]);
  await enqueue([['report', R.legacy]]);
  let s0 = await snap();
  const r2a = await run();
  const legacyAfter = await chunks('report', R.legacy);
  const changedIdx = legacyAfter.filter((ch, i) => legacyBefore[i]?.ct !== ch.ct).map((ch) => ch.section);
  const vecSame = legacyAfter.filter((ch, i) => legacyBefore[i]?.em !== ch.em).length === 1;
  check('one insight edited: 1 request with exactly 1 input, 1 chunk row + 1 document row updated', r2a.req === 1 && r2a.inputs === 1 && r2a.d.ai_chunks.u === 1 && !r2a.d.ai_chunks.i && !r2a.d.ai_chunks.d && r2a.d.ai_documents.u === 1, J({ req: r2a.req, in: r2a.inputs, d: r2a.d }));
  check('the changed chunk is the overall insights section; every other vector identical; chunk_count unchanged', changedIdx.length === 1 && /overall/i.test(changedIdx[0]) && vecSame && legacyAfter.length === legacyBefore.length, J(changedIdx));
  check('no other document touched (ctid)', moved(s0, await snap()).filter((k) => k.startsWith('d:')).length === 1);

  T('T2-B');
  const oldProse = qaDocs.get('qa-prose3');
  const docOf = (id) => qaExtractor.toDocument({ id, ...qaDocs.get(id) });
  const before = (await chunkDocument(docOf('qa-prose3'), chunkParamsFor('qa_test'), { model: MODEL })).chunks;
  const txt = oldProse.sections[0].text.replace('paragraph 6:', 'paragraph 6 (zqrevised):');
  qaDocs.set('qa-prose3', { sections: [{ ...oldProse.sections[0], text: txt }] });
  const after = (await chunkDocument(docOf('qa-prose3'), chunkParamsFor('qa_test'), { model: MODEL })).chunks;
  const expectNew = after.filter((ch) => !before.some((b) => b.content_hash === ch.content_hash)).length;
  await enqueue([['qa_test', 'qa-prose3']]);
  const r2b = await run();
  check(`paragraph edit in a ${before.length}-chunk section: embeds = chunks whose hash changed (${expectNew}), 1 ≤ n ≤ ${before.length}`,
    r2b.inputs === expectNew && expectNew >= 1 && expectNew <= before.length && before.length >= 3, `inputs ${r2b.inputs}, expected ${expectNew}, chunks ${before.length}`);

  T('T2-C');
  // Pick an EMPTY section of the single-layout report whose filling shifts later chunk indexes.
  const single = FX.weeklySingle();
  const cand = ['operationalUpdates', 'upcomingCampaigns', 'actionItems'];
  const liveSingle = await one(`select data from reports where id = $1`, [R.single]);
  const storedHashes = (await chunks('report', R.single)).map((x) => x.content_hash);
  let pick = null, exp = null;
  for (const f of cand) {
    const dataX = { ...liveSingle.data, [f]: `<p>QA Zq zqnewsection ${f} filled in.</p>` };
    const srcRow = { id: String(R.single), type: 'weekly', brand_id: brand, author_id: P.apc_a, status: 'approved', period_label: `QA Zq ${single.period_label}`,
      period_start: '2099-03-16', period_end: '2099-03-22', data: dataX, sections_enabled: null };
    const d2 = extractors.report.toDocument(srcRow, { brand: { brand_name: 'QA Zq Brand', client_name: 'QA Zq Client', currency: 'USD' } });
    const ch2 = (await chunkDocument(d2, chunkParamsFor('report'), { model: MODEL })).chunks;
    const newH = ch2.filter((x) => !storedHashes.includes(x.content_hash));
    const shifted = ch2.filter((x) => storedHashes.includes(x.content_hash) && storedHashes[x.chunk_index] !== x.content_hash).length;
    if (shifted > 0) { pick = f; exp = { newH: newH.length, shifted }; break; }
  }
  if (pick) {
    await q(`update reports set data = jsonb_set(data, $2::text[], to_jsonb($3::text)) where id = $1`, [R.single, `{${pick}}`, `<p>QA Zq zqnewsection ${pick} filled in.</p>`]);
    await enqueue([['report', R.single]]);
    const r2c = await run();
    check(`new section (${pick}) ahead of ${exp.shifted} shifted chunks: embeds only the ${exp.newH} new chunk(s), shifted ones keep their vectors (F4)`,
      r2c.inputs === exp.newH && r2c.s.reused_chunks >= exp.shifted, `inputs ${r2c.inputs}, reused ${r2c.s.reused_chunks}`);
  } else check('could not find a section whose filling shifts indexes (layout-dependent); F4 covered by T2-A/T6', true, 'skipped');

  // ── T3: status-only transitions (approved only, Owner) ────────────────
  T('T3');
  const statusRun = async (st) => {
    await q(`update reports set status = $2 where id = $1`, [R.monthly, st]);
    await enqueue([['report', R.monthly]], st === 'approved' ? 'upsert' : 'delete', st === 'approved' ? 5 : 1);
    return run();
  };
  const mBefore = await chunks('report', R.monthly);
  const t3a = await statusRun('submitted');
  const dm = await doc('report', R.monthly);
  const boss3 = (await searchAs(P.boss, 'Double down on knives')).some((r) => r.source_id === String(R.monthly));
  check('approved → submitted: soft delete, 0 requests, 0 chunk writes, hidden from ai_search (boss)', t3a.req === 0 && t3a.s.soft_deleted === 1 && dm.status === 'deleted' && dm.nrows === mBefore.length
    && !t3a.d.ai_chunks.i && !t3a.d.ai_chunks.u && !t3a.d.ai_chunks.d && !boss3, J({ req: t3a.req, st: dm.status, d: t3a.d.ai_chunks }));
  const t3b = await statusRun('verified');
  check('submitted → verified (still not approved): noop, 0 writes', t3b.req === 0 && t3b.s.noop === 1 && zeroStore(t3b.d), J(t3b.d));
  const t3c = await statusRun('approved');
  const mAfter = await chunks('report', R.monthly);
  check('verified → approved (text unchanged): 0 requests, 0 chunk writes, 1 document update, vectors identical, searchable',
    t3c.req === 0 && !t3c.d.ai_chunks.i && !t3c.d.ai_chunks.u && !t3c.d.ai_chunks.d && t3c.d.ai_documents.u === 1
    && J(mAfter.map((x) => x.em)) === J(mBefore.map((x) => x.em)) && (await searchAs(P.boss, 'Double down on knives')).some((r) => r.source_id === String(R.monthly)), J(t3c.d));
  await statusRun('draft');
  await q(`update reports set data = jsonb_set(data, '{recommendations}', to_jsonb('<p>Double down on knives, zqwhiledraft.</p>'::text)) where id = $1`, [R.monthly]);
  const t3e = await statusRun('approved');
  check('approved → draft → edited → approved: only the edited chunk embedded', t3e.inputs === 1 && t3e.req === 1, `inputs ${t3e.inputs}`);
  const dm2 = await doc('report', R.monthly);
  check('status lives in metadata only; no chunk contains "status"', dm2.metadata.status === 'approved' && !(await chunks('report', R.monthly)).some((x) => /status:/i.test(x.content)));

  // ── T5: deletes, ACL-only changes, SOP link move ──────────────────────
  T('T5-B');
  const genDoc = await doc('report', R.generic);
  await q(`delete from reports where id = $1`, [R.generic]);
  await enqueue([['report', R.generic]], 'delete', 1);
  const t5b = await run();
  const left = (await one(`select count(*)::int n from ai_chunks where document_id = $1`, [genDoc.id])).n;
  check('source row DELETE: document hard-deleted, chunks cascade, 0 requests', t5b.s.deleted === 1 && !(await doc('report', R.generic)) && left === 0 && t5b.req === 0, J({ del: t5b.s.deleted, left }));
  await enqueue([['report', R.generic]]);
  const t5b2 = await run();
  check('re-run after delete: noop, 0 writes', t5b2.s.noop === 1 && zeroStore(t5b2.d));

  T('T5-D');
  const kbD0 = await doc('kb_article', K.office);
  await q(`update kb_articles set visibility = 'role', visible_to_roles = '{ol}' where id = $1`, [K.office]);
  await enqueue([['kb_article', K.office]], 'acl', 0);
  const t5d = await run();
  const kbD1 = await doc('kb_article', K.office);
  check('KB office → role {ol}: 0 requests, 0 chunk writes, 1 document update (acl_roles, visibility, doc_hash)',
    t5d.req === 0 && !t5d.d.ai_chunks.i && !t5d.d.ai_chunks.u && !t5d.d.ai_chunks.d && t5d.d.ai_documents.u === 1
    && kbD1.acl_roles.join() === 'ol' && kbD1.metadata.visibility === 'role' && kbD1.doc_hash !== kbD0.doc_hash, J(t5d.d));
  check('the APC loses it immediately; the OL keeps it', !(await searchAs(P.apc_a, 'zqacloffice')).length && (await searchAs(P.ol, 'zqacloffice')).length > 0);
  await enqueue(all, 'upsert', 9);
  const s5 = await snap();
  const t5d2 = await drain();
  check('full re-enqueue after the ACL change: 0 requests, 0/0/0, no ctid moved (F7)', t5d2.req === 0 && zeroStore(t5d2.d) && moved(s5, await snap()).length === 0, J(t5d2.d));

  T('T5-E');
  await q(`update kb_articles set approval_status = 'pending' where id = $1`, [K.users]);
  await enqueue([['kb_article', K.users]], 'acl', 0);
  const t5e = await run();
  check('KB approval revoked: soft delete, 0 requests, hidden', t5e.s.soft_deleted === 1 && t5e.req === 0 && !(await searchAs(P.boss, 'zqaclusers')).length);
  await q(`update kb_articles set approval_status = 'approved' where id = $1`, [K.users]);
  await enqueue([['kb_article', K.users]], 'acl', 0);
  const t5e2 = await run();
  check('re-approved unchanged: 0 requests, 0 chunk writes, visible again', t5e2.req === 0 && !t5e2.d.ai_chunks.i && !t5e2.d.ai_chunks.u && (await searchAs(P.boss, 'zqaclusers')).length > 0);

  T('T5-F');
  const s5f = await snap();
  await q(`update ai_assistant_docs set kb_article_id = $2 where id = $1`, [D.sop, K.sopB]);
  await enqueue([['ai_doc', D.sop], ['kb_article', K.olsop], ['kb_article', K.sopB]]);
  const t5f = await run();
  const touchedDocs = moved(s5f, await snap()).filter((k) => k.startsWith('d:'));
  const docIds = await q(`select id::text, source_id from ai_documents where source_id = any($1)`, [[String(K.olsop), String(K.sopB)]]);
  check('SOP link moved A → B: only A and B documents rewritten; the SOP text now only under B (office)',
    touchedDocs.length === 2 && touchedDocs.every((k) => docIds.some((d) => `d:${d.id}` === k))
    && (await searchAs(P.apc_a, 'zqsoplinked')).some((r) => r.source_id === String(K.sopB)) && !(await searchAs(P.boss, 'zqsoplinked')).some((r) => r.source_id === String(K.olsop)),
    `${touchedDocs.length} docs, embeds ${t5f.inputs}`);
  check('SOP link moved: embeds = only chunk texts not stored before', t5f.inputs <= 3, `inputs ${t5f.inputs}`);
  await q(`update ai_assistant_docs set kb_article_id = $2 where id = $1`, [D.sop, K.olsop]);
  await enqueue([['ai_doc', D.sop], ['kb_article', K.olsop], ['kb_article', K.sopB]]);
  await run();

  // ── T6: brand rename → only that brand's headers ──────────────────────
  T('T6');
  const brandReports = [R.single, R.legacy, R.biweekly, R.monthly].map(String);
  const beforeCh = {};
  for (const id of brandReports) beforeCh[id] = await chunks('report', id);
  const nBrandChunks = Object.values(beforeCh).reduce((a, x) => a + x.length, 0);
  const s6 = await snap();
  await q(`update brands set brand_name = 'QA Zq Brand Renamed' where id = $1`, [brand]);
  await enqueue(brandReports.map((id) => ['report', id]), 'upsert', 8);
  const t6 = await run();
  const afterCh = {};
  for (const id of brandReports) afterCh[id] = await chunks('report', id);
  const bodyIdentical = brandReports.every((id) => afterCh[id].length === beforeCh[id].length && afterCh[id].every((ch, i) => {
    const [h1, ...rest1] = beforeCh[id][i].content.split('\n'); const [h2, ...rest2] = ch.content.split('\n');
    return rest1.join('\n') === rest2.join('\n') && h1.replace('QA Zq Brand', 'QA Zq Brand Renamed') === h2;
  }));
  const otherTouched = moved(s6, await snap()).filter((k) => k.startsWith('d:')).length;
  check(`rename: re-embedded = all ${nBrandChunks} chunks of the brand's 4 approved reports`, t6.inputs === nBrandChunks, `inputs ${t6.inputs}`);
  check('rename: line 1 (header) differs only by the name; every later line byte-identical', bodyIdentical);
  check('rename: only those 4 documents rewritten (other brand untouched)', otherTouched === 4, otherTouched);
  check('rename: metadata.brand_name and title updated', (await doc('report', R.single)).metadata.brand_name === 'QA Zq Brand Renamed');
  await enqueue(brandReports.map((id) => ['report', id]), 'upsert', 9);
  const t6b = await run();
  check('rename run 2 = nothing', t6b.req === 0 && zeroStore(t6b.d));

  // ── T12 + T11: ACL through ai_search with real-extractor documents ────
  T('T12');
  const viewers = { boss: P.boss, ol: P.ol, tl: P.tl_other, apc_a: P.apc_a, apc_b: P.apc_b, dev: P.dev, mgr: P.mgr };
  const cvr = async (u) => (await one(`select can_view_report($1, $2, $3) v`, [brand, P.apc_a, u])).v;
  const repExp = {};
  for (const [k, u] of Object.entries(viewers)) repExp[k] = k === 'boss' || await cvr(u);
  // K.office is now role {ol} (T5-D); K.users is users {apc_a}
  const matrix = [
    ['weekly report (single)', 'lunchbox', String(R.single), repExp],
    ['KB role {ol} (was office)', 'zqacloffice', String(K.office), { boss: 1, ol: 1, tl: 0, apc_a: 0, apc_b: 0, dev: 1, mgr: roleOf[P.mgr] === 'ol' ? 1 : 0 }],
    ['KB role {tl}', 'zqacltl', String(K.tl), { boss: 1, ol: 1, tl: 1, apc_a: 0, apc_b: 0, dev: 1, mgr: ['tl', 'ol'].includes(roleOf[P.mgr]) ? 1 : 0 }],
    ['KB users {apc_a}', 'zqaclusers', String(K.users), { boss: 1, ol: 1, tl: 0, apc_a: 1, apc_b: 0, dev: 1, mgr: roleOf[P.mgr] === 'ol' ? 1 : 0 }],
    ['KB private', 'zqaclpriv', String(K.priv), { boss: 1, ol: 1, tl: 0, apc_a: 0, apc_b: 0, dev: 1, mgr: roleOf[P.mgr] === 'ol' ? 1 : 0 }],
    ['KB role {ol} + linked SOP', 'zqsoplinked', String(K.olsop), { boss: 1, ol: 1, tl: 0, apc_a: 0, apc_b: 0, dev: 1, mgr: roleOf[P.mgr] === 'ol' ? 1 : 0 }],
    ['curated ai_doc', 'zqaclcurated', String(D.curated), { boss: 1, ol: 1, tl: 1, apc_a: 1, apc_b: 1, dev: 1, mgr: 1 }],
    ['app_guide roles {ol}', 'zqaclguideol', String(D.guideOl), { boss: 1, ol: 1, tl: 0, apc_a: 0, apc_b: 0, dev: 0, mgr: roleOf[P.mgr] === 'ol' ? 1 : 0 }],
    ['app_guide salaries {boss}', 'zqaclguidepay', String(D.guidePay), { boss: 1, ol: 0, tl: 0, apc_a: 0, apc_b: 0, dev: 0, mgr: 0 }],
    ['tts_article', 'zqacltts', 'qa-tts-1', { boss: 1, ol: 1, tl: 1, apc_a: 1, apc_b: 1, dev: 1, mgr: 1 }],
    ['incentive plan of apc_a', 'zqaclinc', String(incentive), { boss: 1, ol: 1, tl: 0, apc_a: 1, apc_b: 0, dev: 0, mgr: 1 }],
  ];
  let leaks = 0, missing = 0; const bad = [];
  for (const [label, kw, sid, exp] of matrix) {
    for (const [who, uid] of Object.entries(viewers)) {
      const hit = (await searchAs(uid, kw)).some((r) => r.source_id === sid);
      const want = !!exp[who];
      if (hit && !want) { leaks++; bad.push(`LEAK ${label}→${who}`); }
      if (!hit && want) { missing++; bad.push(`MISSING ${label}→${who}`); }
    }
    const svc = (await searchAs(null, kw, { service: true, asUser: P.apc_b })).some((r) => r.source_id === sid);
    const spoof = (await searchAs(P.apc_b, kw, { asUser: P.boss })).some((r) => r.source_id === sid);
    if (svc !== !!exp.apc_b) { (svc ? leaks++ : missing++); bad.push(`service-as-apc_b ${label}`); }
    if (spoof !== !!exp.apc_b) { (spoof ? leaks++ : missing++); bad.push(`apc_b spoofing boss ${label}`); }
  }
  check(`ACL matrix through ai_search: ${matrix.length} docs × ${Object.keys(viewers).length + 2} callers, 0 leaks, 0 missing`, !leaks && !missing, bad.join('; ') || `mgr role ${roleOf[P.mgr]}`);
  check('unlinked imported SOP: 0 documents, its text not findable by anyone', !(await doc('ai_doc', D.orphanSop)) && !(await searchAs(P.boss, 'zqaclorphan')).length);

  T('T11');
  // T6 renamed the brand its commission line names (the 374 brands trigger
  // re-queues such incentives): bring the document up to date first.
  await enqueue([['incentive', incentive]], 'upsert', 8);
  const t11r = await run();
  check('brand rename reaches the incentive naming it: exactly its commission chunk re-embedded', t11r.inputs === 1, `inputs ${t11r.inputs}`);
  const incCh = await chunks('incentive', incentive);
  const incText = incCh.map((x) => x.content).join('\n');
  check('incentive chunks: amounts + targets present (plan indexed)', /PKR 5,000\.00/.test(incText) && /target: 30/.test(incText));
  check('incentive chunks: no basic salary (7777777.77 in any format)', !/7,?777,?777/.test(incText));
  check('incentive chunks: no achieved values / completion (987654321, 55555, 3333333, completed)', !/987,?654,?321|55,?555|3,?333,?333|completed(At|By)?\b/i.test(incText.replace(/computed live/g, '')));
  check('incentive chunks: commission_tier amount stripped (4444444 absent)', !/4,?444,?444/.test(incText));
  const incDoc = await doc('incentive', incentive);
  check('incentive document: acl_mode incentive, author = employee; verified/paid only in metadata', incDoc.acl_mode === 'incentive' && incDoc.author_id === P.apc_a && 'verified' in incDoc.metadata && !/verified|payout_cleared|paid:/i.test(incText), incDoc.acl_mode);
  check('incentive document metadata carries no basic salary / achieved', !/7777777|987654321|basic_salary|achieved/i.test(J(incDoc.metadata)));
  // progress-only + verify: 0 embeds
  await q(`update incentives set incentives = jsonb_set(incentives, '{0,achievedValue}', '123456789'), verified = true, payout_cleared = true where id = $1`, [incentive]);
  await enqueue([['incentive', incentive]]);
  const t11p = await run();
  const incCh2 = await chunks('incentive', incentive);
  const chDiff = incCh2.filter((x, i) => incCh[i]?.content !== x.content || incCh[i]?.content_hash !== x.content_hash)
    .map((x) => ({ i: x.chunk_index, sameHash: incCh[x.chunk_index]?.content_hash === x.content_hash }));
  check('progress + verified + paid: 0 requests, 0 chunk writes, 1 document update', t11p.req === 0 && !t11p.d.ai_chunks.i && !t11p.d.ai_chunks.u && !t11p.d.ai_chunks.d && t11p.d.ai_documents.u === 1, J(t11p.d) + ' diff ' + J(chDiff));

  // inc_select ≡ ai_can_read_document('incentive') for EVERY active viewer × every profile as target
  const targets = await q(`select id from profiles where deleted_at is null`);
  const vw = await q(`select id, role from profiles where is_active and deleted_at is null`);
  for (const t of targets) {
    await q(`insert into incentives (user_id, month, incentives) values ($1, '2099-12', '[{"id":"m","text":"QA Zq matrix","amount":1}]')`, [t.id]);
    await q(`insert into ai_documents (source_type, source_id, title, acl_mode, author_id, doc_hash, status) values ('qa_incmatrix', $1::text, 'QA', 'incentive', $1::uuid, 'x', 'active')`, [t.id]);
  }
  let agree = 0, disagree = []; let extraOverRls = 0;
  for (const v of vw) {
    await c.query('savepoint m');
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [J({ sub: v.id, role: 'authenticated' })]);
    await c.query('set local role authenticated');
    const rls = new Set((await q(`select user_id::text u from incentives where month = '2099-12'`)).map((r) => r.u));
    await c.query('rollback to savepoint m');
    const acl = new Set((await q(`select d.source_id u from ai_documents d where d.source_type = 'qa_incmatrix' and ai_can_read_document(d, $1, $2)`, [v.id, v.role])).map((r) => r.u));
    for (const t of targets) {
      const a = acl.has(t.id), b = rls.has(t.id);
      if (a === b) agree++; else { disagree.push(`${v.role}→${a ? 'acl-only' : 'rls-only'}`); if (a) extraOverRls++; }
    }
  }
  check(`incentive ACL ≡ inc_select for ${vw.length} active viewers × ${targets.length} targets (0 extra, 0 missing)`, !disagree.length, `${agree} agree; ${[...new Set(disagree)].join(', ')}`);
  const incMine = await q(`select source_id from ai_documents d where d.source_type = 'qa_incmatrix' and ai_can_read_document(d, $1, 'apc')`, [P.apc_b]);
  check('an unrelated APC sees exactly one incentive document: their own', incMine.length === 1 && incMine[0].source_id === P.apc_b, incMine.length);
  const incTl = await q(`select count(*)::int n from ai_documents d join profiles p on p.id = d.author_id
      where d.source_type = 'qa_incmatrix' and ai_can_read_document(d, $1, 'tl') and d.author_id <> $1 and p.reports_to is distinct from $1`, [P.tl_other]);
  check('a TL sees no incentive of someone who does not report to them', incTl[0].n === 0, incTl[0].n);
  await q(`delete from ai_documents where source_type = 'qa_incmatrix'`);
  await q(`delete from incentives where month = '2099-12'`);

  // T11-C: every REAL incentive row through the real extractor + chunker, in memory, counts only
  T('T11-C');
  const realInc = (await rpc('ai_ingest_source', { p_type: 'incentive', p_ids: null, p_payload: true })) ?? [];
  const basics = new Map((await q(`select i.id::text, i.basic_salary, ec.basic_salary ec_basic from incentives i left join employee_compensation ec on ec.user_id = i.user_id`)).map((r) => [r.id, r]));
  let scanned = 0, chunkN = 0, salaryHits = 0, achievedKeys = 0, achievedWords = 0, amtCollide = 0;
  for (const src of realInc) {
    const payloadStr = J(src.payload?.row ?? {});
    if (/"(achievedValue|completed|completedAt|completedBy|_commissionInfo)"/.test(payloadStr)) achievedKeys++;
    const { row, ctx } = loaders.incentive(src.payload);
    if (!extractors.incentive.indexable(row, ctx)) continue;
    scanned++;
    const dd = extractors.incentive.toDocument(row, ctx);
    const chs = (await chunkDocument(dd, chunkParamsFor('incentive'), { model: MODEL })).chunks;
    chunkN += chs.length;
    const text = chs.map((x) => x.content).join('\n');
    const b = basics.get(src.source_id);
    for (const v of [b?.basic_salary, b?.ec_basic]) {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 1000) continue;
      if (text.includes(pkr(n))) {
        const planAmounts = [...(row.incentives ?? []), ...(row.bonuses ?? [])].map((x) => Number(x.amount));
        if (planAmounts.includes(n)) amtCollide++; else salaryHits++;
      }
    }
    if (/achiev|\bcompleted\b/i.test(text.replace(/achieved values and completion are computed live/g, ''))) achievedWords++;
  }
  check(`${scanned} real incentive plans → ${chunkN} chunks in memory: 0 contain the person's basic salary`, salaryHits === 0, `${salaryHits} hits (${amtCollide} equal to a plan amount, ignored)`);
  check('0 payloads carry achievedValue/completed* keys (stripped in SQL)', achievedKeys === 0, achievedKeys);
  check('0 chunks mention achieved / completed', achievedWords === 0, achievedWords);

  // ── T11-OFF (mig 377): incentives switched off by ONE update of the admin
  // setting, then back on. Synthetic plans only (QA Zq, 2099 months).
  T('T11-OFF');
  const newPlan = async (month, text) => {
    const id = (await one(`insert into incentives (user_id, month, incentives) values ($1, $2, $3) returning id`,
      [P.apc_a, month, J([{ id: 'o1', text, targetValue: 10, suffix: '', amount: 1000 }])])).id;
    synth.add(String(id));
    return String(id);
  };
  const incEdit = await newPlan('2099-02', 'QA Zq zqoffedit post 10 lives');    // edited while off
  const incGone = await newPlan('2099-03', 'QA Zq zqoffgone post 5 lives');     // source row deleted while off
  const incIdle = await newPlan('2099-04', 'QA Zq zqoffidle post 7 lives');     // nothing queued while off
  await enqueue([['incentive', incEdit], ['incentive', incGone], ['incentive', incIdle]]);
  const tPrep = await run();
  check('setup: 3 more synthetic plans indexed', tPrep.s.written === 3 && !tPrep.s.failed, J({ w: tPrep.s.written, f: tPrep.s.failed }));
  const IDS = { zqaclinc: String(incentive), zqoffedit: incEdit, zqoffgone: incGone, zqoffidle: incIdle };
  const who = { boss: P.boss, ol: P.ol, employee: P.apc_a, manager: P.mgr };
  const visibility = async () => {
    const o = {};
    for (const [kw, sid] of Object.entries(IDS)) {
      for (const [w, uid] of Object.entries(who)) o[`${kw}/${w}`] = (await searchAs(uid, kw)).some((r) => r.source_id === sid);
      o[`${kw}/relay`] = (await searchAs(null, kw, { service: true, asUser: P.apc_a })).some((r) => r.source_id === sid);
    }
    return o;
  };
  const incState = async () => one(`select count(*) filter (where d.status = 'active')::int active, count(*) filter (where d.status = 'deleted')::int deleted,
      (select count(*)::int from ai_chunks c join ai_documents x on x.id = c.document_id where x.source_type = 'incentive' and x.source_id = any($1)) chunks,
      (select string_agg(md5(c.embedding::text), '' order by x.source_id, c.chunk_index) from ai_chunks c join ai_documents x on x.id = c.document_id
        where x.source_type = 'incentive' and x.source_id = any($1)) vecs
      from ai_documents d where d.source_type = 'incentive' and d.source_id = any($1)`, [Object.values(IDS)]);
  const vOn = await visibility();
  check('while on: boss, OL, the employee, their manager and the service relay (as the employee) all find the 4 plans',
    Object.values(vOn).every(Boolean), J(Object.entries(vOn).filter(([, v]) => !v).map(([k]) => k)));
  const stOn = await incState();

  // OFF: one statement
  const sOff = await stat();
  await q(`update ai_assistant_config set ingest_sources = array_remove(ingest_sources, 'incentive') where id = 1`);
  const dOff = delta(sOff, await stat());
  const vOff = await visibility();
  check('OFF (one UPDATE): hidden at once from boss / OL / employee / manager / service relay, for all 4 plans',
    Object.values(vOff).every((v) => !v), J(Object.entries(vOff).filter(([, v]) => v).map(([k]) => k)));
  const stOff = await incState();
  check('OFF: the switch itself writes nothing to the store; documents stay active, chunks + vectors kept (hidden, not purged)',
    zeroStore(dOff) && J(stOff) === J(stOn) && stOn.active === 4, J({ d: dOff, stOn: { ...stOn, vecs: undefined }, stOff: { ...stOff, vecs: undefined } }));
  const offTypes = (await one(`select ai_source_types() v`)).v;
  const offStats = (await one(`select ai_ingest_stats() v`)).v;
  check('OFF: ai_source_types() and ai_ingest_stats().ingest_sources no longer list incentive',
    !offTypes.includes('incentive') && !offStats.ingest_sources.includes('incentive'), J(offTypes));

  // a queued item of the switched-off type: the source text changed (would need an embed if on)
  await q(`update incentives set incentives = jsonb_set(incentives, '{0,text}', '"QA Zq zqoffedit post 10 lives EDITED zqoffnew"') where id = $1`, [incEdit]);
  await q(`delete from incentives where id = $1`, [incGone]);
  // only the 4 items queued while off: incIdle's setup item (done earlier) is not one of them
  const qMark = (await one(`select coalesce(max(id), 0) n from ai_ingest_queue`)).n;
  await enqueue([['incentive', incentive]]);
  await enqueue([['incentive', incEdit]]);
  await enqueue([['incentive', incGone]], 'delete', 5);
  await enqueue([['employee_compensation', 'qa-never-listed']]);          // a type that was never in the list
  const tOff = await run();
  const qOff = await q(`select source_type, source_id, status, attempts, last_error from ai_ingest_queue
      where ((source_type = 'incentive' and source_id = any($1)) or source_id = 'qa-never-listed') and id > $2 order by id desc`, [Object.values(IDS), qMark]);
  const latest = new Map(); for (const r of qOff) if (!latest.has(r.source_id)) latest.set(r.source_id, r);
  const stQ = await incState();
  check('OFF + 4 queued items (upsert, edited upsert, delete, never-listed type): 0 HTTP requests, 0 embeds, 0 failures, disabled = 4',
    tOff.req === 0 && tOff.s.embedded_chunks === 0 && !tOff.s.failed && tOff.s.disabled === 4 && tOff.s.succeeded === 4,
    J({ req: tOff.req, e: tOff.s.embedded_chunks, f: tOff.s.failed, dis: tOff.s.disabled, ok: tOff.s.succeeded, err: tOff.s.errors }));
  check('OFF: every such item is completed (done, attempt 1, no error), not failed / retried',
    [...latest.values()].length === 4 && [...latest.values()].every((r) => r.status === 'done' && r.attempts === 1 && !r.last_error), J([...latest.values()].map((r) => `${r.source_type.slice(0, 3)}:${r.status}:${r.attempts}:${r.last_error ?? ''}`)));
  check('OFF: the 3 queued plans are soft-deleted, 0 chunk writes, vectors identical; the idle plan untouched',
    stQ.active === 1 && stQ.deleted === 3 && stQ.chunks === stOn.chunks && stQ.vecs === stOn.vecs
    && !tOff.d.ai_chunks.i && !tOff.d.ai_chunks.u && !tOff.d.ai_chunks.d && tOff.d.ai_documents.u === 3 && !tOff.d.ai_documents.i,
    J({ st: { ...stQ, vecs: undefined }, d: tOff.d }));
  check('OFF: the never-listed type left no document', !(await doc('employee_compensation', 'qa-never-listed')));
  check('OFF: ai_ingest_stats().failed lists nothing', !(await one(`select ai_ingest_stats() v`)).v.failed.length);

  let wOff = 'accepted';
  try { await rpc('ai_ingest_write', { p_doc: { source_type: 'incentive', source_id: 'qa-direct', doc_hash: 'h', embed_model: model, acl_mode: 'incentive', author_id: P.apc_a }, p_chunks: [] }); }
  catch (e) { wOff = /not enabled/.test(e.message) ? 'refused' : e.message.slice(0, 60); }
  check('OFF: a direct ai_ingest_write of an incentive is refused ("not enabled")', wOff === 'refused', wOff);

  const bOff = (await one(`select ai_backfill('incentive') v`)).v;
  const cOff = (await one(`select count(*)::int n from ai_backfill_candidates('incentive')`)).n;
  const eOff = (await one(`select ai_enqueue_stale(array['incentive'], 8, 'reconcile', false, 500) v`)).v;
  // ai_reconcile() walks every enabled type; reports/KB would pull REAL rows, so
  // the enabled list is narrowed to tts_article (dev holds only our 2 articles).
  const saved = (await one(`select ingest_sources v from ai_assistant_config where id = 1`)).v;
  await q(`update ai_assistant_config set ingest_sources = '{tts_article}' where id = 1`);
  const rOff = (await one(`select ai_reconcile(500) v`)).v;
  await q(`update ai_assistant_config set ingest_sources = $1 where id = 1`, [saved]);
  const qAfter = (await one(`select count(*)::int n from ai_ingest_queue where status = 'pending'`)).n;
  check('OFF: ai_backfill(\'incentive\') = {}, candidates 0 (nothing to re-add or delete), stale/reconcile enqueue nothing',
    J(bOff) === '{}' && cOff === 0 && J(eOff) === '{}' && J(rOff) === '{}' && qAfter === 0, J({ bOff, cOff, eOff, rOff, qAfter }));

  // who may flip the switch (RLS policy ai_config_write → is_ai_admin)
  const flip = {};
  for (const [w, uid] of Object.entries({ apc: P.apc_a, ol: P.ol, tl: P.tl_other, boss: P.boss, developer: P.dev })) {
    await c.query('savepoint cfg');
    try {
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [J({ sub: uid, role: 'authenticated' })]);
      await c.query('set local role authenticated');
      const up = await c.query(`update ai_assistant_config set ingest_sources = ingest_sources || '{incentive}' where id = 1`);
      let ins = 'refused';
      await c.query('savepoint ins');
      try { await c.query(`insert into ai_assistant_config (id, ingest_sources) values (2, '{incentive}')`); ins = 'inserted'; }
      catch { await c.query('rollback to savepoint ins'); }
      await c.query('reset role');
      flip[w] = { updated: up.rowCount, insert: ins, on: (await one(`select 'incentive' = any(ai_source_types()) v`)).v };
    } catch (e) { flip[w] = { error: e.message.slice(0, 60) }; }
    finally { await c.query('rollback to savepoint cfg'); }
  }
  // Owner (2026-09-29, final): only the Boss may change ingest_sources; a Developer may not.
  check('APC, OL, TL and Developer cannot switch it on (0 rows, still off) nor add a config row',
    ['apc', 'ol', 'tl', 'developer'].every((w) => flip[w].updated === 0 && !flip[w].on && flip[w].insert === 'refused'), J(flip));
  check('the Boss can switch it back on (one UPDATE, is_ai_admin = boss, mig 207)', flip.boss.updated === 1 && flip.boss.on, J(flip.boss));

  // ...and the same the other way: with it on, only the Boss can switch it off
  await q(`update ai_assistant_config set ingest_sources = ingest_sources || '{incentive}' where id = 1`);
  const flipOff = {};
  for (const [w, uid] of Object.entries({ apc: P.apc_a, ol: P.ol, tl: P.tl_other, boss: P.boss, developer: P.dev })) {
    await c.query('savepoint cfg');
    try {
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [J({ sub: uid, role: 'authenticated' })]);
      await c.query('set local role authenticated');
      const up = await c.query(`update ai_assistant_config set ingest_sources = array_remove(ingest_sources, 'incentive') where id = 1`);
      await c.query('reset role');
      flipOff[w] = { updated: up.rowCount, on: (await one(`select 'incentive' = any(ai_source_types()) v`)).v };
    } catch (e) { flipOff[w] = { error: e.message.slice(0, 60) }; }
    finally { await c.query('rollback to savepoint cfg'); }
  }
  await q(`update ai_assistant_config set ingest_sources = array_remove(ingest_sources, 'incentive') where id = 1`);
  check('APC, OL, TL and Developer cannot switch it off (0 rows, still on)',
    ['apc', 'ol', 'tl', 'developer'].every((w) => flipOff[w].updated === 0 && flipOff[w].on), J(flipOff));
  check('the Boss can switch it off (one UPDATE)', flipOff.boss.updated === 1 && !flipOff.boss.on, J(flipOff.boss));
  check('no ai_set_source_enabled RPC exists (Owner: no Developer path)',
    !(await one(`select exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'ai_set_source_enabled') v`)).v);

  // ON again
  const sOn = await stat();
  await q(`update ai_assistant_config set ingest_sources = ingest_sources || '{incentive}' where id = 1`);
  const vBack = await visibility();
  check('ON: the plan with nothing queued while off is visible again at once, 0 store writes',
    zeroStore(delta(sOn, await stat())) && ['boss', 'ol', 'employee', 'manager', 'relay'].every((w) => vBack[`zqoffidle/${w}`]), J(vBack));
  check('ON: the soft-deleted plans stay hidden until the backfill', ['zqaclinc', 'zqoffedit', 'zqoffgone'].every((k) => !vBack[`${k}/boss`]));
  const revCand = await q(`select source_id, op, why from ai_backfill_candidates('incentive') where source_id = any($1) order by op, why`, [Object.values(IDS)]);
  const candMap = Object.fromEntries(revCand.map((r) => [r.source_id, `${r.op}:${r.why}`]));
  check('ON: backfill candidates (synthetic rows) = revived ×2 (unchanged + edited), delete:orphan for the deleted source, none for the idle plan',
    candMap[incentive] === 'upsert:revived' && candMap[incEdit] === 'upsert:revived' && candMap[incGone] === 'delete:orphan' && !candMap[incIdle] && revCand.length === 3, J(candMap));
  // the backfill, restricted to our synthetic rows (a real ai_backfill would enqueue the real plans: hold)
  for (const r of revCand) await q(`select ai_enqueue('incentive', $1, $2, 9, interval '0', 'backfill')`, [r.source_id, r.op]);
  const tBack = await drain();
  const stBack = await incState();
  const vRev = await visibility();
  check('ON + backfill: the unchanged plan revived with 0 embeds; the plan edited while off embeds only its 1 changed chunk',
    tBack.inputs === 1 && tBack.texts.every((x) => /zqoffnew/.test(x)) && !tBack.s.failed, J({ in: tBack.inputs, req: tBack.req, f: tBack.s.failed }));
  check('ON + backfill: the orphan (source deleted while off) is hard-deleted with its chunks',
    !(await doc('incentive', incGone)) && stBack.active === 3 && !stBack.deleted, J({ ...stBack, vecs: undefined }));
  check('ON + backfill: boss / OL / employee / manager / relay see the 3 live plans again; the deleted one never',
    ['zqaclinc', 'zqoffedit', 'zqoffidle'].every((k) => ['boss', 'ol', 'employee', 'manager', 'relay'].every((w) => vRev[`${k}/${w}`]))
    && !['boss', 'ol', 'employee', 'manager', 'relay'].some((w) => vRev[`zqoffgone/${w}`]), J(Object.entries(vRev).filter(([k, v]) => v === k.startsWith('zqoffgone')).map(([k]) => k)));
  const cAfter = (await one(`select count(*)::int n from ai_backfill_candidates('incentive') where source_id = any($1)`, [Object.values(IDS)])).n;
  check('ON: a second backfill finds nothing for these plans', cAfter === 0, cAfter);

  // ── T4: pipeline bump, model change, reconcile budget ────────────────
  T('T4-A');
  const indexedNow = (await one(`select count(*)::int n from ai_documents where source_id = any($1) and status = 'active'`, [mineIds])).n;
  await q(`create or replace function public.ai_pipeline_version() returns text language sql stable as $$ select 'qa-bump-2'::text $$`);
  pipeline = 'qa-bump-2';
  await enqueue(all, 'upsert', 9);
  const s4 = await snap();
  const t4a = await drain();
  check(`pipeline bump: every active document reprocessed once (${indexedNow}), 0 requests (text unchanged)`, t4a.s.written === indexedNow && t4a.req === 0 && t4a.d.ai_documents.u === indexedNow && !t4a.d.ai_chunks.i && !t4a.d.ai_chunks.d && !t4a.d.ai_chunks.u, J({ w: t4a.s.written, d: t4a.d }));
  await enqueue(all, 'upsert', 9);
  const t4a2 = await drain();
  check('after the bump: idempotent (0 requests, 0/0/0)', t4a2.req === 0 && zeroStore(t4a2.d), J(t4a2.d));
  check('pipeline salt includes the chunk params + table/cap/token limits (a size change is detected, F2)', pipelineSalt('report', 'v') === 'v|450/700/60/40|12/40/7500', pipelineSalt('report', 'v'));

  T('T4-C');
  const chunkN4 = (await one(`select count(*)::int n from ai_chunks c join ai_documents d on d.id = c.document_id where d.source_id = any($1) and d.status = 'active'`, [mineIds])).n;
  const distinct4 = (await one(`select count(distinct c.embed_text)::int n from ai_chunks c join ai_documents d on d.id = c.document_id where d.source_id = any($1) and d.status = 'active'`, [mineIds])).n;
  await q(`create or replace function public.ai_embed_model() returns text language sql stable as $$ select 'qa-embed-v2'::text $$`);
  model = 'qa-embed-v2';
  net.maxBatch = 0;
  await enqueue(all, 'upsert', 9);
  const t4c = await drain();
  const models = await q(`select c.embedding_model m, count(*)::int n from ai_chunks c join ai_documents d on d.id = c.document_id where d.source_id = any($1) group by 1`, [mineIds]);
  check(`model change: every distinct chunk text re-embedded exactly once (${distinct4} texts in ${chunkN4} chunks), ≤ 96 per request`,
    t4c.inputs === new Set(t4c.texts).size && t4c.inputs === distinct4 && net.maxBatch <= 96, `inputs ${t4c.inputs}, req ${t4c.req}, max ${net.maxBatch}`);
  check('model change: every chunk now carries the new model', models.length === 1 && models[0].m === 'qa-embed-v2', J(models));
  await enqueue(all, 'upsert', 9);
  const t4c2 = await drain();
  check('model change run 2: idempotent', t4c2.req === 0 && zeroStore(t4c2.d));

  T('T4-D');
  // Only tts_article is safe for ai_enqueue_stale here: dev holds no real TikTok rows.
  await q(`create or replace function public.ai_pipeline_version() returns text language sql stable as $$ select 'qa-bump-3'::text $$`);
  pipeline = 'qa-bump-3';
  const moreTts = Array.from({ length: 5 }, (_, i) => ({ id: `qa-tts-b${i}`, kind: 'essay', url: `https://example.com/b${i}`, title: `QA Zq budget ${i}`, text: `QA Zq budget article ${i} zqbudget.` }));
  await importArticles(c, moreTts);
  await enqueue(moreTts.map((r) => ['tts_article', r.id]));
  await q(`update ai_ingest_queue set not_before = now() - interval '1 second' where status = 'pending'`);
  await drain();
  await q(`create or replace function public.ai_pipeline_version() returns text language sql stable as $$ select 'qa-bump-4'::text $$`);
  pipeline = 'qa-bump-4';
  const drift = (await one(`select count(*)::int n from ai_backfill_candidates('tts_article') where why = 'pipeline'`)).n;
  const budgets = [];
  for (let i = 0; i < 10; i++) {
    const v = (await one(`select ai_enqueue_stale(array['tts_article'], 8, 'reconcile', false, 2) v`)).v;
    const n = v?.tts_article?.pipeline ?? 0;
    budgets.push(n);
    await q(`update ai_ingest_queue set not_before = now() - interval '1 second' where status = 'pending'`);
    await drain();
    if (!n) break;
  }
  check(`reconcile budget 2 over ${drift} drifted docs: 2 per call, then 0`, drift === 7 && J(budgets) === J([2, 2, 2, 1, 0]), `drift ${drift}, per call ${J(budgets)}`);

  // ── T7: crashes, zombies, poison ─────────────────────────────────────
  T('T7-A');
  for (let i = 1; i <= 20; i++) qaDocs.set(`qa-crash-${i}`, { sections: [{ key: 'b', title: 'Body', kind: 'prose', text: `QA Zq crash item ${i} zqcrash${i} unique text.` }] });
  await q(`update ai_ingest_queue set status = 'done' where status <> 'done'`);
  await enqueue(Array.from({ length: 20 }, (_, i) => ['qa_test', `qa-crash-${i + 1}`]));
  let writes = 0, dead = false;
  const dying = async (fn, args) => {
    if (dead) throw new Error('process died');
    if (fn === 'ai_ingest_write') { if (writes === 7) { dead = true; throw new Error('process died'); } writes++; }
    return rpc(fn, args);
  };
  const n7 = net.inputs;
  let died = false;
  try { await run({ rpc: dying, batch: 20 }); } catch { died = true; }
  const st7 = await q(`select status, count(*)::int n from ai_ingest_queue where source_id like 'qa-crash-%' group by 1 order by 1`);
  check('abort after 7 writes: 7 done, 13 processing', died && J(st7) === J([{ status: 'done', n: 7 }, { status: 'processing', n: 13 }]), J(st7));
  const stuck = new Set((await q(`update ai_ingest_queue set locked_at = now() - interval '11 minutes' where status = 'processing' returning source_id`)).map((r) => r.source_id));
  const firstEmbeds = net.inputs - n7;
  const t7 = await run({ batch: 20 });
  const reEmbedded = new Set(t7.texts.map((x) => /zqcrash(\d+)/.exec(x)?.[1]).filter(Boolean).map((n) => `qa-crash-${n}`));
  const crashDocs = await q(`select d.source_id, d.chunk_count, count(c.id)::int n from ai_documents d left join ai_chunks c on c.document_id = d.id where d.source_id like 'qa-crash-%' group by 1, 2`);
  const att = await q(`select attempts, status, count(*)::int n from ai_ingest_queue where source_id like 'qa-crash-%' group by 1, 2 order by 1`);
  check('resume: 20 documents exactly, chunk_count = rows everywhere', crashDocs.length === 20 && crashDocs.every((r) => r.chunk_count === r.n), crashDocs.length);
  check('resume: first run embedded 20, second only the 13 unwritten items (the 7 written never again)',
    firstEmbeds === 20 && t7.inputs === 13 && stuck.size === 13 && reEmbedded.size === 13 && [...reEmbedded].every((id) => stuck.has(id)), `first ${firstEmbeds}, second ${t7.inputs}`);
  check('resume: attempts = 2 on items 8–20, all done, none failed', J(att) === J([{ attempts: 1, status: 'done', n: 7 }, { attempts: 2, status: 'done', n: 13 }]), J(att));

  T('T7-B');
  await q(`create function public.qa_zq_boom() returns trigger language plpgsql as $$ begin if new.content like '%zqboom%' then raise exception 'qa boom inside write'; end if; return new; end $$`);
  await q(`create trigger qa_boom before insert or update on ai_chunks for each row execute function public.qa_zq_boom()`);
  qaDocs.set('qa-boom', { sections: [{ key: 'a', title: 'A', kind: 'prose', text: 'QA Zq fine first chunk text zqfine.' }, { key: 'b', title: 'B', kind: 'prose', text: 'QA Zq zqboom chunk.' }] });
  qaDocs.set('qa-fine', { sections: [{ key: 'a', title: 'A', kind: 'prose', text: 'QA Zq zqfine2 other item.' }] });
  await enqueue([['qa_test', 'qa-boom'], ['qa_test', 'qa-fine']]);
  const t7b = await run();
  const boomQ = await one(`select status, extract(epoch from not_before - now())::int due, last_error from ai_ingest_queue where source_id = 'qa-boom' order by id desc limit 1`);
  check('write raising mid-document: no partial rows for it, item back to pending with 1-minute backoff, the other item done',
    !(await doc('qa_test', 'qa-boom')) && boomQ.status === 'pending' && boomQ.due === 60 && /qa boom/.test(boomQ.last_error) && !!(await doc('qa_test', 'qa-fine')) && t7b.s.failed === 1, J(boomQ));
  await q(`drop trigger qa_boom on ai_chunks`);
  await q(`update ai_ingest_queue set status = 'done' where source_id = 'qa-boom'`);

  T('T7-C');
  qaDocs.set('qa-zombie', { sections: [{ key: 'a', title: 'A', kind: 'prose', text: 'QA Zq zombie v1 zqzombie.' }] });
  await enqueue([['qa_test', 'qa-zombie']]);
  const [itA] = await q(`select * from ai_ingest_claim(1, 'worker-A')`);
  const { planDocument } = await import('../../../supabase/functions/_shared/ai/ingest/plan.ts');
  const srcA = (await qaSource.fetch(['qa-zombie']))[0];
  const planA = await planDocument('qa_test', srcA, null, { pipelineVersion: pipeline, model }, qaSource);   // A's stale view
  await q(`update ai_ingest_queue set locked_at = now() - interval '11 minutes' where id = $1`, [itA.id]);
  qaDocs.set('qa-zombie', { sections: [{ key: 'a', title: 'A', kind: 'prose', text: 'QA Zq zombie v2 NEWER zqzombie.' }] });
  const tB = await run({ worker: 'worker-B' });
  const hashB = (await doc('qa_test', 'qa-zombie')).doc_hash;
  const vA = (await embedFor(model)(planA.toEmbed.map((x) => x.embed_text))).vectors;
  const lateA = await rpc('ai_ingest_write', { p_doc: planA.docRow, p_chunks: planA.chunks.map((ch, i) => ({ ...ch, embedding: vA[i] })), p_queue_id: itA.id, p_worker: 'worker-A' });
  const complA = await rpc('ai_ingest_complete', { p_id: itA.id, p_worker: 'worker-A' });
  check('zombie A finishing after B reclaimed and wrote: write refused (lost_lock), complete false, B\'s newer document kept',
    tB.s.written === 1 && lateA.ok === false && complA === false && (await doc('qa_test', 'qa-zombie')).doc_hash === hashB && /NEWER/.test((await chunks('qa_test', 'qa-zombie'))[0].content), J(lateA));

  T('T7-D');
  qaDocs.set('qa-poison', { boom: true, sections: [] });
  await enqueue([['qa_test', 'qa-poison']]);
  for (let i = 0; i < 6; i++) { await q(`update ai_ingest_queue set not_before = now() - interval '1 second' where source_id = 'qa-poison' and status = 'pending'`); await run(); }
  const poison = await one(`select status, attempts from ai_ingest_queue where source_id = 'qa-poison' order by id desc limit 1`);
  const stats = await one(`select ai_ingest_stats() v`);
  check('poison item: failed after 5 attempts and listed by ai_ingest_stats()', poison.status === 'failed' && poison.attempts === 5 && stats.v.failed.some((f) => f.source_id === 'qa-poison'), J(poison));

  T('T8-B');
  const w1 = await rpc('ai_ingest_write', { p_doc: { source_type: 'qa_test', source_id: 'qa-twice', doc_hash: 'h1', embed_model: model, acl_mode: 'all', title: 'QA 1' },
    p_chunks: [{ chunk_index: 0, section: 'a', content: 'one', embed_text: 'one', token_count: 1, content_hash: 'x1', embedding: fakeVec('one') }, { chunk_index: 1, section: 'a', content: 'two', embed_text: 'two', token_count: 1, content_hash: 'x2', embedding: fakeVec('two') }] });
  const w2 = await rpc('ai_ingest_write', { p_doc: { source_type: 'qa_test', source_id: 'qa-twice', doc_hash: 'h2', embed_model: model, acl_mode: 'all', title: 'QA 2' },
    p_chunks: [{ chunk_index: 0, section: 'a', content: 'three', embed_text: 'three', token_count: 1, content_hash: 'x3', embedding: fakeVec('three') }] });
  const tw = await q(`select d.doc_hash, d.chunk_count, (select string_agg(content, ',' order by chunk_index) from ai_chunks c where c.document_id = d.id) ch from ai_documents d where source_id = 'qa-twice'`);
  check('same source written twice: 1 document, chunks = the second call\'s', w1.ok && w2.ok && tw.length === 1 && tw[0].doc_hash === 'h2' && tw[0].ch === 'three' && tw[0].chunk_count === 1, J(tw));

  T('R8');
  // Mig 377 (B1): an allow-list first, then an unanchored deny-list as a second net.
  const tryWrite = async (t) => {
    try { await rpc('ai_ingest_write', { p_doc: { source_type: t, source_id: 'qa-deny', doc_hash: 'h', embed_model: model, acl_mode: 'boss', acl_roles: ['boss'] }, p_chunks: [] }); return 'accepted'; }
    catch (e) { return /not enabled/.test(e.message) ? 'not enabled' : /never indexed/.test(e.message) ? 'never indexed' : e.message.slice(0, 50); }
  };
  const sensitive = ['employee_compensation', 'payroll', 'basic_salary', 'salary_history', 'attendance', 'leave_requests', 'performance_ratings',
    'Salaries', 'compensation', 'EMPLOYEE_COMPENSATION', 'x_payroll_y', 'staff_leave'];
  const r8a = {};
  for (const t of [...sensitive, 'qa_unknown_type', '']) r8a[t || '(empty)'] = await tryWrite(t);
  check('allow-list refuses employee_compensation, payroll, basic_salary, salary_history, attendance, leave_requests, performance_ratings and an unknown type',
    [...sensitive, 'qa_unknown_type'].every((t) => r8a[t] === 'not enabled'), J(r8a));
  // '' is caught by the required-fields check before the allow-list: a different message, same outcome (refused)
  check('empty source_type refused (required-fields check or allow-list)',
    r8a['(empty)'] !== 'accepted' && (/are required|source_type, source_id/.test(r8a['(empty)']) || r8a['(empty)'] === 'not enabled'), r8a['(empty)']);
  const r8saved = (await one(`select ingest_sources v from ai_assistant_config where id = 1`)).v;
  // Mig 380: an admin can no longer ADD them: the save is refused (23514) ...
  await q('savepoint r8');
  const r8save = await c.query(`update ai_assistant_config set ingest_sources = ingest_sources || $1::text[] where id = 1`, [sensitive]).then(() => 'accepted', (e) => e.code);
  await q('rollback to savepoint r8');
  check('380: adding them to ingest_sources is refused at save time (23514)', r8save === '23514', r8save);
  // ... so the deny-list (the second net) is exercised with the trigger bypassed.
  await q(`alter table ai_assistant_config disable trigger ai_assistant_config_sources_check`);
  await q(`update ai_assistant_config set ingest_sources = ingest_sources || $1::text[] where id = 1`, [sensitive]);
  const r8b = {};
  for (const t of sensitive) r8b[t] = await tryWrite(t);
  // Since 379, ai_source_types() drops any name that is neither canon nor a test
  // fixture, so the write is refused as "not enabled" before 377's deny-list
  // ("never indexed") is even reached: either refusal is correct.
  check('second net: with all of them in ingest_sources anyway (trigger bypassed), every one is still refused (379 filter / 377 deny-list)',
    sensitive.every((t) => r8b[t] === 'never indexed' || r8b[t] === 'not enabled'), J(r8b));
  check('second net: no document was created for any of them',
    !(await one(`select count(*)::int n from ai_documents where source_id = 'qa-deny'`)).n);
  await q(`update ai_assistant_config set ingest_sources = $1 where id = 1`, [r8saved]);
  await q(`alter table ai_assistant_config enable trigger ai_assistant_config_sources_check`);
  check('control: an enabled, harmless type (qa_test) is accepted', (await tryWrite('qa_test')) === 'accepted');
  check('hold guard: no foreign (non-synthetic) queue item ever reached the worker', foreignRemoved === 0, foreignRemoved);

  // ── T9-B: synthetic backfill twice (tts only: dev holds no real TikTok rows) ─
  T('T9-B');
  const realTts = (await one(`select count(*)::int n from tts_articles where knowledge_id not like 'qa-%'`)).n;
  if (!realTts) {
    await q(`update ai_ingest_queue set status = 'done' where status <> 'done'`);
    const b1 = (await one(`select ai_backfill('tts_article') v`)).v;
    const b2 = (await one(`select ai_backfill('tts_article') v`)).v;
    check('backfill with nothing stale enqueues nothing, twice', J(b1) === '{}' && J(b2) === '{}', `${J(b1)} ${J(b2)}`);
    tts[1] = { ...tts[1], text: `${tts[1].text}\nThird line zqshipping new.` };
    await importArticles(c, [tts[1]]);
    const b3 = (await one(`select ai_backfill('tts_article') v`)).v;
    const b4 = (await one(`select ai_backfill('tts_article') v`)).v;
    await enqueue([['qa_test', 'qa-one']], 'upsert', 5);
    await q(`update ai_ingest_queue set not_before = now() - interval '1 second' where status = 'pending'`);
    const [first] = await q(`select * from ai_ingest_claim(1, 'qa-prio')`);
    check('one article changed: backfill enqueues exactly it; a second backfill adds nothing', J(b3) === '{"tts_article":{"changed":1}}' && J(b4) === '{}', `${J(b3)} ${J(b4)}`);
    check('a live priority-5 item is claimed before the priority-9 backfill item', first?.priority === 5 && first?.source_id === 'qa-one', J(first && { p: first.priority, s: first.source_id }));
    await q(`update ai_ingest_queue set status = 'pending', locked_by = null where id = $1`, [first.id]);
    const t9 = await drain();
    // qa-one is still on pipeline qa-bump-3 (T4-D bumped only TikTok docs): a document-row catch-up, 0 embeds.
    check('drain: only the changed article\'s new chunk embedded (qa-one: pipeline catch-up, 0 embeds)', t9.inputs === 1 && t9.s.written === 2 && !t9.s.failed, J({ w: t9.s.written, in: t9.inputs }));
    check('backfill after the drain: nothing', J((await one(`select ai_backfill('tts_article') v`)).v) === '{}');
  } else check('skipped: tts_articles has real rows', true);

  // ── T10: TikTok import ───────────────────────────────────────────────
  T('T10');
  const s10 = await stat();
  const i2 = await importArticles(c, [...tts].reverse().map((r) => ({ ...r, views: (r.views ?? 0) + 5000 })));
  const d10 = delta(s10, await stat());
  check('import of the same file (reordered, views changed): 0 inserts, 0 updates, tts_articles rows untouched', i2.inserted === 0 && i2.updated === 0 && !d10.tts_articles.i && !d10.tts_articles.u, J({ i2, d: d10.tts_articles }));
  const dup = [
    { id: 'qa-dup', kind: 'course_lesson', url: 'https://x/1', title: 'QA dup', text: 'Lesson text version A, longer text here.', course: { learning_id: '9', lesson_index: 2, name: 'C9' }, modified_at: '2099-02-01' },
    { id: 'qa-dup', kind: 'essay', url: 'https://x/2', title: 'QA dup', text: 'Essay text version B.', modified_at: '2099-01-01' },
    { id: 'qa-dup', kind: 'course_lesson', url: 'https://x/3', title: 'QA dup', text: 'Lesson text version C.', course: { learning_id: '3', lesson_index: 0, name: 'C3' }, modified_at: '2099-03-01' },
    { id: 'qa-dup', kind: 'course_lesson', url: 'https://x/4', title: 'QA dup', text: '', modified_at: '2099-04-01' },
  ];
  const perms = [[0, 1, 2, 3], [3, 2, 1, 0], [2, 0, 3, 1], [1, 3, 0, 2]];
  const hs = new Set();
  for (const p of perms) hs.add((await crawlToRows(p.map((i) => dup[i]))).rows[0].content_hash);
  check('duplicate id, different content, 4 orders: one winner, same content_hash every time (F6)', hs.size === 1, hs.size);
  const crawl = path.join(ASSISTANT, 'data', 'tts-academy', 'articles.jsonl');
  if (fs.existsSync(crawl)) {
    const recs = fs.readFileSync(crawl, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    const base = new Map((await crawlToRows(recs)).rows.map((r) => [r.knowledge_id, r.content_hash]));
    let diff = 0;
    for (let k = 0; k < 8; k++) {
      const shuffled = recs.map((r) => [crypto.randomInt(1e9), r]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
      for (const r of (await crawlToRows(shuffled)).rows) if (base.get(r.knowledge_id) !== r.content_hash) diff++;
    }
    check(`real crawl (${recs.length} records, in memory): 8 random orders give identical content_hash for all ${base.size} articles`, diff === 0, `${diff} differences`);
  }
  await importArticles(c, [{ ...tts[0], text: `${tts[0].text} Also zqreturns2 added.` }]);
  await enqueue([['tts_article', 'qa-tts-1']]);
  const t10b = await run();
  check('one body changed → only that article\'s changed chunk embedded', t10b.s.written === 1 && t10b.inputs === 1, J({ w: t10b.s.written, in: t10b.inputs }));
} catch (e) {
  check(`test aborted: ${e.message}`, false, e.stack?.split('\n').slice(1, 3).join(' '));
} finally {
  let intact = false;
  try { intact = (await one('select pg_current_xact_id()::text as x')).x === xid; } catch { intact = true; }
  await c.query('rollback').catch(() => {});
  let post = null;
  try { post = await one(`select (select count(*)::int from ai_documents) d, (select count(*)::int from ai_chunks) ch, (select count(*)::int from tts_articles) t, (select count(*)::int from ai_ingest_queue) q`); } catch { /* connection gone */ }
  await c.end().catch(() => {});
  let cur = '';
  for (const r of results) { const s = r.name.split(' ')[0]; if (s !== cur) { cur = s; } console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? `  [${r.detail}]` : ''}`); }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed in ${((Date.now() - t0) / 1000).toFixed(1)} s. ${intact ? '(rolled back: nothing committed)' : '!!! transaction id changed: something may have been COMMITTED'}`);
  console.log(`after rollback: ${J(post)}`);
  process.exitCode = failed || !intact ? 1 : 0;
}
