// Phase 2B: "process each piece of data once" — fingerprints, volatile fields,
// chunk reuse by content, the incentive extractor, TikTok dedupe, and the
// small DB adapter. Pure: no database, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chunkDocument } from '../chunker.ts';
import { CHUNK_PARAMS, chunkParamsFor, DEFAULT_CONFIG, PIPELINE_VERSION, pipelineSalt } from '../config.ts';
import { SOURCE_TYPES } from '../extractors/index.ts';
import { goalLine, incentiveExtractor, monthLabel, pkr } from '../extractors/incentive.ts';
import type { IncentiveRow } from '../extractors/incentive.ts';
import { kbExtractor } from '../extractors/kb.ts';
import type { KbRow } from '../extractors/kb.ts';
import { reportExtractor } from '../extractors/report.ts';
import { ttsExtractor } from '../extractors/tts.ts';
import { docHash } from '../hash.ts';
import { pgRpc } from '../ingest/db.ts';
import type { ExistingDoc, SourceRecord } from '../ingest/db.ts';
import { planDocument } from '../ingest/plan.ts';
import { crawlToRows, recordCmp } from '../ingest/ttsImport.ts';
import type { CrawlRecord } from '../ingest/ttsImport.ts';
import { emptyStats, processBatch } from '../ingest/worker.ts';
import * as F from './fixtures/reports.ts';

const O = { pipelineVersion: PIPELINE_VERSION, model: DEFAULT_CONFIG.EMBED_MODEL };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(HERE, '../../../../migrations');

// ---------------------------------------------------------------- pipeline constants
test('SQL ai_pipeline_version() (latest migration defining it) equals PIPELINE_VERSION', () => {
  const files = fs.readdirSync(MIGRATIONS).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  let sqlVersion: string | null = null;
  let sqlModel: string | null = null;
  for (const f of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8');
    const v = /function public\.ai_pipeline_version\(\)[\s\S]*?select '([^']+)'/.exec(sql);
    const m = /function public\.ai_embed_model\(\)[\s\S]*?select '([^']+)'/.exec(sql);
    if (v) sqlVersion = v[1];
    if (m) sqlModel = m[1];
  }
  assert.equal(sqlVersion, PIPELINE_VERSION);
  assert.equal(sqlModel, DEFAULT_CONFIG.EMBED_MODEL);
});

test('chunking/embedding rules are pinned to the pipeline version (bump PIPELINE_VERSION + ai_pipeline_version() when this fails)', () => {
  const rules = Object.fromEntries(Object.keys(CHUNK_PARAMS).sort().map((t) => [t, pipelineSalt(t, 'v')]));
  assert.deepEqual({ version: PIPELINE_VERSION, rules }, {
    version: '2026-09-28.1',
    rules: {
      agenda_presentation: 'v|450/700/50/30|12/40/7500',
      agenda_task: 'v|450/700/50/30|12/40/7500',
      ai_doc: 'v|550/800/80/60|12/40/7500',
      app_guide: 'v|500/800/60/60|12/40/7500',
      brand_profile: 'v|450/700/50/30|12/40/7500',
      gmv_max_report: 'v|450/700/50/30|12/40/7500',
      incentive: 'v|450/700/50/30|12/40/7500',
      kb_article: 'v|550/800/80/60|12/40/7500',
      report: 'v|450/700/60/40|12/40/7500',
      tts_article: 'v|600/750/90/60|12/40/7500',
    },
  });
});

// ---------------------------------------------------------------- fingerprint
// (Key order inside `data` can change section order, but the loader's jsonb
// always arrives in Postgres's canonical key order, so it is stable.)
test('doc_hash is stable across extractions, and moves with text, pipeline and model', async () => {
  const salt = pipelineSalt('report');
  const a = await docHash(reportExtractor.toDocument(F.weeklyLegacy(), F.CTX), salt, O.model);
  const b = await docHash(reportExtractor.toDocument(F.weeklyLegacy(), F.CTX), salt, O.model);
  assert.equal(a, b);
  const edited = F.weeklyLegacy();
  (edited.data as Record<string, unknown>).topCreatorsInsights = 'A brand new insight.';
  assert.notEqual(await docHash(reportExtractor.toDocument(edited, F.CTX), salt, O.model), a);
  assert.notEqual(await docHash(reportExtractor.toDocument(F.weeklyLegacy(), F.CTX), pipelineSalt('report', 'bumped'), O.model), a);
  assert.notEqual(await docHash(reportExtractor.toDocument(F.weeklyLegacy(), F.CTX), salt, 'other-model'), a);
  // A report chunk-size change alters report salts only (QA T4-B).
  assert.notEqual(pipelineSalt('report'), pipelineSalt('kb_article'));
});

test('volatile fields never reach doc_hash: report updated_at, TikTok views', async () => {
  const salt = pipelineSalt('report');
  const a = await docHash(reportExtractor.toDocument({ ...F.weeklyLegacy(), updated_at: '2026-01-01T00:00:00Z' }, F.CTX), salt, O.model);
  const b = await docHash(reportExtractor.toDocument({ ...F.weeklyLegacy(), updated_at: '2026-09-01T00:00:00Z' }, F.CTX), salt, O.model);
  assert.equal(a, b);
  const tts = { knowledge_id: 'k1', kind: 'essay', url: 'https://x/k1', title: 'T', body: 'Body text.', is_active: true };
  const ta = await docHash(ttsExtractor.toDocument({ ...tts, views: 10 }, undefined), pipelineSalt('tts_article'), O.model);
  const tb = await docHash(ttsExtractor.toDocument({ ...tts, views: 99999 }, undefined), pipelineSalt('tts_article'), O.model);
  assert.equal(ta, tb);
});

// ---------------------------------------------------------------- planner
const src = (row: unknown, fp = 'fp1', extra: Record<string, unknown> = {}): SourceRecord =>
  ({ source_id: 'r1', indexable: true, fp, payload: { row, ...extra } });

async function stored(type: string, s: SourceRecord): Promise<ExistingDoc> {
  const p = await planDocument(type, s, null, O);
  assert.equal(p.action, 'write');
  if (p.action !== 'write') throw new Error('unreachable');
  return { source_id: s.source_id, doc_hash: p.docRow.doc_hash as string, source_fp: s.fp, pipeline_version: O.pipelineVersion,
           embed_model: O.model, status: 'active', chunk_hashes: p.chunks.map((c) => c.content_hash) };
}
const brandCtx = { brand: F.CTX.brand };

test('planner: unchanged → skip; fp-only change → touch; new → write everything', async () => {
  const s = src(F.weeklyLegacy(), 'fp1', brandCtx);
  const first = await planDocument('report', s, null, O);
  assert.equal(first.action, 'write');
  if (first.action === 'write') assert.equal(first.toEmbed.length, first.chunks.length);
  const ex = await stored('report', s);
  assert.deepEqual(await planDocument('report', s, ex, O), { action: 'skip' });
  assert.deepEqual(await planDocument('report', { ...s, fp: 'fp2' }, ex, O), { action: 'touch', fp: 'fp2' });
});

test('planner: approved only — reopening soft-deletes, re-approving with the same text embeds nothing', async () => {
  assert.equal(F.weeklyLegacy().status, 'approved');
  const s = src(F.weeklyLegacy(), 'fp1', brandCtx);
  const ex = await stored('report', s);
  for (const status of ['submitted', 'verified', 'draft']) {
    const p = await planDocument('report', src({ ...F.weeklyLegacy(), status }, 'fp2', brandCtx), ex, O);
    assert.equal(p.action, 'delete', status);
    if (p.action === 'delete') { assert.equal(p.soft, true); assert.match(p.reason, /only approved/); }
  }
  assert.equal((await planDocument('report', src({ ...F.weeklyLegacy(), status: 'submitted' }, 'fp2', brandCtx), null, O)).action, 'noop');
  const back = await planDocument('report', s, { ...ex, status: 'deleted' }, O);
  assert.equal(back.action, 'write');
  if (back.action === 'write') assert.equal(back.toEmbed.length, 0);
});

test('planner: a pipeline bump re-writes the document but embeds nothing; a model change re-embeds all', async () => {
  const s = src(F.weeklyLegacy(), 'fp1', brandCtx);
  const ex = await stored('report', s);
  const bumped = await planDocument('report', s, ex, { ...O, pipelineVersion: 'bumped' });
  assert.equal(bumped.action, 'write');
  if (bumped.action === 'write') { assert.equal(bumped.toEmbed.length, 0); assert.equal(bumped.docRow.pipeline_version, 'bumped'); }
  const newModel = await planDocument('report', s, ex, { ...O, model: 'other-model' });
  if (newModel.action === 'write') assert.equal(newModel.toEmbed.length, newModel.chunks.length);   // a model change re-embeds all
});

test('planner: one edited insight → exactly one chunk to embed', async () => {
  const s = src(F.weeklyLegacy(), 'fp1', brandCtx);
  const ex = await stored('report', s);
  const edited = F.weeklyLegacy();
  (edited.data as Record<string, unknown>).topCreatorsInsights = 'Creator one tripled her output after the new brief.';
  const p = await planDocument('report', src(edited, 'fp2', brandCtx), ex, O);
  assert.equal(p.action, 'write');
  if (p.action === 'write') {
    assert.equal(p.toEmbed.length, 1);
    assert.equal(p.toEmbed[0].section, 'insights:creators');
  }
});

test('planner: a section inserted early shifts every later chunk, yet only the new one is embedded (reuse by hash)', async () => {
  const base = F.weeklyLegacy();
  (base.data as Record<string, unknown>).operationalUpdates = '';
  const s = src(base, 'fp1', brandCtx);
  const ex = await stored('report', s);
  const filled = F.weeklyLegacy();
  (filled.data as Record<string, unknown>).operationalUpdates = 'We moved all sample shipping to the new 3PL this week.';
  const p = await planDocument('report', src(filled, 'fp2', brandCtx), ex, O);
  assert.equal(p.action, 'write');
  if (p.action === 'write') {
    assert.equal(p.toEmbed.length, 1);
    assert.equal(p.toEmbed[0].section, 'written:operational');
    assert.ok(p.stats.reusedMoved > 0, 'later chunks moved index and were reused');
    assert.equal(p.chunks.length, ex.chunk_hashes.length + 1);
  }
});

test('planner: draft → soft delete (vectors kept); re-publish embeds nothing; gone → hard delete', async () => {
  const s = src(F.weeklyLegacy(), 'fp1', brandCtx);
  const ex = await stored('report', s);
  const draft = await planDocument('report', src({ ...F.weeklyLegacy(), status: 'draft' }, 'fp2', brandCtx), ex, O);
  assert.equal(draft.action, 'delete');
  if (draft.action === 'delete') assert.equal(draft.soft, true);
  const softDeleted = { ...ex, status: 'deleted' };
  assert.equal((await planDocument('report', src({ ...F.weeklyLegacy(), status: 'draft' }, 'fp2', brandCtx), softDeleted, O)).action, 'noop');
  const again = await planDocument('report', s, softDeleted, O);
  assert.equal(again.action, 'write');
  if (again.action === 'write') assert.equal(again.toEmbed.length, 0);
  const gone = await planDocument('report', null, ex, O);
  assert.deepEqual(gone, { action: 'delete', soft: false, reason: 'source row not found' });
  assert.equal((await planDocument('report', null, null, O)).action, 'noop');
});

test('planner: KB visibility change (ACL only) → document rewritten, zero chunks to embed', async () => {
  const kb = (over: Partial<KbRow> = {}): KbRow => ({ id: 'k1', title: 'How to ship samples', body: '', url: 'https://docs.example/x',
    category: 'operational_sops', visibility: 'office', visible_to_roles: [], visible_to_users: [], created_by: null,
    approval_status: 'approved', sop_group_id: null, version: 1, ...over });
  const s = { source_id: 'k1', indexable: true, fp: 'a', payload: { row: kb(), is_latest: true, linked_docs: [] } };
  const ex = await stored('kb_article', s);
  const p = await planDocument('kb_article', { ...s, fp: 'b', payload: { ...s.payload, row: kb({ visibility: 'role', visible_to_roles: ['ol'] }) } }, ex, O);
  assert.equal(p.action, 'write');
  if (p.action === 'write') {
    assert.equal(p.toEmbed.length, 0);
    assert.deepEqual(p.docRow.acl_roles, ['ol']);
    assert.equal((p.docRow.metadata as any).visibility, 'role');
    assert.notEqual(p.docRow.doc_hash, ex.doc_hash);   // QA F7: the ACL path stores a fresh doc_hash
  }
});

test('KB: a superseded or unapproved version is not indexable; kbExtractor follows the loader', () => {
  const row = { id: 'k1', title: 'T', approval_status: 'approved' } as KbRow;
  assert.ok(kbExtractor.indexable(row, { isLatestVersion: true }));
  assert.ok(!kbExtractor.indexable(row, { isLatestVersion: false }));
  assert.ok(!kbExtractor.indexable({ ...row, approval_status: 'pending' }, { isLatestVersion: true }));
});

// ---------------------------------------------------------------- incentives
const incentiveRow = (over: Partial<IncentiveRow> = {}): IncentiveRow => ({
  id: 'i1', user_id: 'u1', month: '2026-09', verified: false, payout_cleared: false,
  incentives: [
    { id: 'a', text: 'Post 30 videos', targetValue: 30, suffix: '', amount: 5000, achievedValue: 12, completed: false },
    { id: 'b', text: 'Brand GMV goal', targetValue: 10000, suffix: '$', amount: 12500.5, source: 'gmv_max', brandId: 'b1', brandName: 'Old Name', achievedValue: 8000, completed: false },
  ],
  bonuses: [
    { id: 'c', text: 'Attendance', targetValue: 100, suffix: '%', amount: 3000, source: 'attendance', achievedValue: 95, completed: true, completedAt: 'x', completedBy: 'y' },
    { id: 'd', text: 'Commission', targetValue: 1000, suffix: '$', amount: 0, source: 'commission_tier', commissionPct: 0.5, brandId: 'b1' },
  ],
  ...over,
});
const incCtx = { person: { name: 'Test Person', role: 'apc' }, brandNames: { b1: 'Acme Kitchen' } };

test('incentive extractor: one document per row, plan lines, ACL incentive, tool note', () => {
  const d = incentiveExtractor.toDocument(incentiveRow(), incCtx);
  assert.equal(d.title, 'Incentive plan · Test Person · September 2026');
  assert.equal(d.header, '[Incentive plan · Test Person (APC) · September 2026]');
  assert.deepEqual(d.acl, { mode: 'incentive', authorId: 'u1' });
  assert.equal(d.url, '/incentives');
  assert.deepEqual(d.sections.map((s) => [s.key, s.kind]), [['incentives', 'table'], ['bonuses', 'table']]);
  const inc = d.sections[0].text;
  assert.ok(inc.includes('- Goal: Post 30 videos; target: 30; amount: PKR 5,000.00'));
  assert.ok(inc.includes('- Goal: Brand GMV goal; target: 10000$; amount: PKR 12,500.50; linked to: GMV Max result of Acme Kitchen'), 'live brand name wins');
  const bon = d.sections[1].text;
  assert.ok(bon.includes('linked to: monthly attendance %'));
  assert.ok(bon.includes('- Goal: Commission; benchmark: 1000$; commission: 0.5%; amount: computed from the commission at payout; commission on Acme Kitchen GMV above the benchmark'));
  for (const s of d.sections) assert.ok(s.text.endsWith('use the incentives tool (achieved values and completion are computed live).'));
  assert.deepEqual([d.metadata.verified, d.metadata.payout_cleared, d.metadata.month, d.metadata.role], [false, false, '2026-09', 'apc']);
  assert.ok(!incentiveExtractor.indexable(incentiveRow({ incentives: [], bonuses: [] }), incCtx));
});

test('incentive: achieved values, completion, verified and payout never reach a chunk', async () => {
  const chunksOf = async (row: IncentiveRow) =>
    (await chunkDocument(incentiveExtractor.toDocument(row, incCtx), chunkParamsFor('incentive'))).chunks.map((c) => [c.content, c.content_hash]);
  const a = await chunksOf(incentiveRow());
  const progressed = incentiveRow();
  for (const it of [...progressed.incentives!, ...progressed.bonuses!]) { it.achievedValue = 99999; it.completed = true; it.completedAt = 'now'; }
  assert.deepEqual(await chunksOf({ ...progressed, verified: true, payout_cleared: true }), a);
  const all = a.map(([c]) => c).join('\n');
  for (const v of ['12', '8000', '95']) assert.ok(!new RegExp(`\\b${v}\\b`).test(all.replace(/PKR [\d,.]+/g, '')), `achieved ${v} leaked`);
  // verify/pay: one document row changes (metadata), no chunk.
  const s0 = { source_id: 'i1', indexable: true, fp: 'a', payload: { row: incentiveRow(), person: incCtx.person, brands: incCtx.brandNames } };
  const ex = await stored('incentive', s0);
  const p = await planDocument('incentive', { ...s0, fp: 'b', payload: { ...s0.payload, row: incentiveRow({ verified: true }) } }, ex, O);
  assert.equal(p.action, 'write');
  if (p.action === 'write') { assert.equal(p.toEmbed.length, 0); assert.equal((p.docRow.metadata as any).verified, true); }
});

test('incentive helpers: month label, PKR format, unknown source', () => {
  assert.equal(monthLabel('2026-01'), 'January 2026');
  assert.equal(monthLabel('bad'), 'bad');
  assert.equal(pkr(1234567.891), 'PKR 1,234,567.89');
  assert.equal(pkr(-5), '-PKR 5.00');
  assert.equal(pkr('x'), '');
  assert.equal(goalLine({ text: 'X', source: 'ol_brands', targetValue: 70, suffix: '%', amount: 1 }),
    "- Goal: X; target: 70%; amount: PKR 1.00; linked to: % of the OL's curated brands whose GMV goal was met");
});

// ---------------------------------------------------------------- TikTok import dedupe
const rec = (over: Partial<CrawlRecord>): CrawlRecord => ({
  id: '100', kind: 'essay', url: 'https://x/100', title: 'Account Health', breadcrumb: 'Seller > Health', keywords: [],
  toc: [], text: 'Essay text.', views: 1, modified_at: '2026-02-19T08:28:50.734Z', ...over,
});

test('TikTok dedupe: essay wins, lessons sorted into course[], winner independent of file order', async () => {
  const essay = rec({});
  const l2 = rec({ kind: 'course_lesson', url: 'https://x/c2', text: 'Lesson text B, longer than the essay.', course: { learning_id: '9', name: 'Course B', lesson_index: 1 } });
  const l1 = rec({ kind: 'course_lesson', url: 'https://x/c1', text: 'Lesson text A.', course: { learning_id: '10', name: 'Course A', lesson_index: 4 } });
  const a = await crawlToRows([l2, essay, l1]);
  const b = await crawlToRows([l1, l2, essay]);
  assert.deepEqual(a.rows, b.rows);
  assert.equal(a.rows.length, 1);
  assert.equal(a.rows[0].kind, 'essay');
  assert.equal(a.rows[0].body, 'Essay text.');
  assert.deepEqual(a.rows[0].course!.map((c) => c.learning_id), ['9', '10'], 'numeric order of learning_id');
  assert.equal(a.duplicateIds, 1);
  // Lessons only: the lowest (learning_id, lesson_index) wins.
  const c = await crawlToRows([l1, l2]);
  assert.equal(c.rows[0].url, 'https://x/c2');
  assert.equal(c.rows[0].kind, 'course_lesson');
});

test('TikTok dedupe: empty text skipped (or loses to a record with text); views never change content_hash', async () => {
  const r = await crawlToRows([rec({ id: '1', text: '' }), rec({ id: '2', text: '  ' }), rec({ id: '2', kind: 'course_lesson', text: 'Has text', course: { learning_id: '1', lesson_index: 0 } })]);
  assert.deepEqual(r.skippedEmpty, ['1']);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].body, 'Has text');
  const v1 = await crawlToRows([rec({ views: 5 })]);
  const v2 = await crawlToRows([rec({ views: 50000 })]);
  assert.equal(v1.rows[0].content_hash, v2.rows[0].content_hash);
  const edited = await crawlToRows([rec({ text: 'Essay text, edited.' })]);
  assert.notEqual(edited.rows[0].content_hash, v1.rows[0].content_hash);
  assert.ok(recordCmp(rec({}), rec({ kind: 'course_lesson' })) < 0);
});

test('TikTok extractor reads the course[] the importer stores', async () => {
  const { rows } = await crawlToRows([rec({ kind: 'course_lesson', course: { learning_id: '7', name: 'GMV Max', lesson_index: 2, lesson_count: 20 } })]);
  const d = ttsExtractor.toDocument({ ...rows[0], is_active: true }, undefined);
  assert.ok(d.header.startsWith('[TikTok Shop Academy · Courses > GMV Max · '));
  assert.equal(d.sections.at(-1)!.title, 'Lesson 3 of 20');
  assert.deepEqual((d.metadata as any).courses, [{ id: '7', name: 'GMV Max', lesson_index: 2 }]);
  assert.equal((d.metadata as any).views, undefined);
});

// ---------------------------------------------------------------- DB adapter and worker
test('pgRpc: named arguments, text[] vs jsonb, set-returning claim, savepoints', async () => {
  const calls: [string, unknown[]][] = [];
  const client = { query: async (text: string, params?: unknown[]) => { calls.push([text, params ?? []]); return { rows: text.startsWith('select *') ? [{ id: 1 }] : [{ v: { ok: true } }] }; } };
  const rpc = pgRpc(client, { savepoints: true });
  assert.deepEqual(await rpc('ai_ingest_write', { p_doc: { a: 1 }, p_chunks: [], p_queue_id: 5, p_worker: 'w' }), { ok: true });
  assert.deepEqual(await rpc('ai_ingest_claim', { p_limit: 2, p_worker: 'w' }), [{ id: 1 }]);
  await rpc('ai_ingest_source', { p_type: 'report', p_ids: ['x', 'y'], p_payload: true });
  const sql = calls.map(([t]) => t);
  assert.deepEqual(sql.slice(0, 3), ['savepoint ai_rpc', 'select public.ai_ingest_write(p_doc => $1, p_chunks => $2, p_queue_id => $3, p_worker => $4) as v', 'release savepoint ai_rpc']);
  assert.deepEqual(calls[1][1], ['{"a":1}', '[]', 5, 'w']);
  assert.equal(sql[4], 'select * from public.ai_ingest_claim(p_limit => $1, p_worker => $2)');
  assert.deepEqual(calls[7][1], ['report', ['x', 'y'], true], 'a string array stays a text[] argument');
  await assert.rejects(rpc('drop table x; --', {}), /bad function name/);
  const seen: string[] = [];
  const failing = pgRpc({ query: async (t: string) => { seen.push(t); if (t.startsWith('select')) throw new Error('boom'); return { rows: [] }; } }, { savepoints: true });
  await assert.rejects(failing('ai_x', {}), /boom/);
  assert.deepEqual(seen, ['savepoint ai_rpc', 'select public.ai_x() as v', 'rollback to savepoint ai_rpc']);
});

test('worker: a write refused for a lost lock is dropped, not counted as success; embed failure fails only items that needed it', async () => {
  const s = src(F.weeklyLegacy(), 'fp1', brandCtx);
  const rpcCalls: string[] = [];
  const rpc = async (fn: string, args: any = {}) => {
    rpcCalls.push(fn);
    if (fn === 'ai_source_types') return ['report'];
    if (fn === 'ai_ingest_source') return args.p_ids.map((id: string) => ({ ...s, source_id: id }));
    if (fn === 'ai_ingest_existing') return [];
    if (fn === 'ai_ingest_write') return { ok: false, reason: 'lost_lock' };
    if (fn === 'ai_ingest_fail') return true;
    throw new Error(`unexpected ${fn}`);
  };
  const stats = emptyStats();
  let embeds = 0;
  await processBatch([{ id: 1, source_type: 'report', source_id: 'r1', op: 'upsert', attempts: 1 }],
    { rpc, workerId: 'w', ...O, embed: async (t) => { embeds++; return { vectors: t.map(() => [0]), tokens: 1, requests: 1 }; } }, stats);
  assert.equal(embeds, 1);
  assert.equal(stats.lost_lock, 1);
  assert.equal(stats.succeeded, 0);
  const s2 = emptyStats();
  await processBatch([{ id: 2, source_type: 'report', source_id: 'r2', op: 'upsert', attempts: 1 }],
    { rpc, workerId: 'w', ...O, embed: async () => { throw new Error('OpenAI down'); } }, s2);
  assert.equal(s2.failed, 1);
  assert.ok(rpcCalls.includes('ai_ingest_fail'));
  assert.ok(SOURCE_TYPES.includes('incentive'));
});

test('worker: items of a source switched off complete with a soft delete, no other work', async () => {
  const calls: [string, any][] = [];
  let held = true;
  const rpc = async (fn: string, args: any = {}) => {
    calls.push([fn, args]);
    if (fn === 'ai_source_types') return ['report', 'kb_article'];
    if (fn === 'ai_ingest_delete') return held ? { ok: true, deleted: 1, soft: true } : { ok: false, reason: 'lost_lock' };
    throw new Error(`unexpected ${fn}`);
  };
  const stats = emptyStats();
  await processBatch([{ id: 7, source_type: 'incentive', source_id: 'i1', op: 'upsert', attempts: 1 }],
    { rpc, workerId: 'w', ...O, embed: async () => { throw new Error('must not embed'); } }, stats);
  assert.deepEqual(calls.map(([f]) => f), ['ai_source_types', 'ai_ingest_delete']);
  assert.deepEqual(calls[1][1], { p_type: 'incentive', p_id: 'i1', p_soft: true, p_queue_id: 7, p_worker: 'w' });
  assert.deepEqual([stats.disabled, stats.succeeded, stats.failed], [1, 1, 0]);
  held = false;
  const s2 = emptyStats();
  await processBatch([{ id: 8, source_type: 'incentive', source_id: 'i2', op: 'delete', attempts: 1 }],
    { rpc, workerId: 'w', ...O, embed: async () => { throw new Error('must not embed'); } }, s2);
  assert.deepEqual([s2.disabled, s2.succeeded, s2.lost_lock], [0, 0, 1]);
});
