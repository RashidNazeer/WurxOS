// mig 432: free embeddings only. Two vector spaces (main = NVIDIA, second = Gemini), a worker that
// recovers from 429/401 without ever staying 'down', queries embedded in the space the documents live
// in, incentive (pay data) never sent to a free provider, and no path to api.openai.com.
// Faked providers and a fake database only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EmbedError, embedTexts, GEMINI_EMBED_BASE, GEMINI_EMBED_MODEL, MAIN_PROVIDER, MODEL_LABEL,
  NVIDIA_EMBED_ENDPOINT, NVIDIA_EMBED_MODEL, queryVectors, tagVector, vectorModel,
} from '../embedder.ts';
import { DEFAULT_CONFIG, PIPELINE_VERSION } from '../config.ts';
import {
  backfillVectors, deferSeconds, emptyStats, paceMs, processBatch, providerEmbedder, PROVIDER_DEFER_SECONDS, runWorker,
  TRANSIENT_DEFER_SECONDS, NO_KEY_DEFER_SECONDS,
} from '../ingest/worker.ts';
import { runIngest } from '../ingest/run.ts';
import { searchIndex } from '../retrieval/search.ts';
import { chainEmbedder, _resetEmbedDown } from '../agent/server.ts';
import { reportExtractor } from '../extractors/report.ts';
import * as F from './fixtures/reports.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AI = path.resolve(HERE, '..');
const O = { pipelineVersion: PIPELINE_VERSION, model: DEFAULT_CONFIG.EMBED_MODEL };
const vec = (x: number) => Array.from({ length: 1536 }, (_, i) => (i === 0 ? x : 0.001));
const QUOTA_NV = JSON.stringify({ status: 429, detail: 'You have exceeded your free quota' });
const NO_KEY_REFUSED = JSON.stringify({ detail: 'Invalid JWT serialization' });
const GEMINI_DAY = JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED',
  message: 'You exceeded your current quota. Quota exceeded for metric: embed_content_free_tier_requests, limit: 1000, model: gemini-embedding-001, Embed content requests per day limit exceeded on Free Tier. Please retry in 13h5m20.2s.' } });
const GEMINI_MINUTE = JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED',
  message: 'You exceeded your current quota. limit: 100, Embed content requests per minute limit exceeded on Free Tier. Please retry in 29.9s.' } });

type Seen = { url: string; body: any; headers: Record<string, string> };
// A fake HTTP layer for BOTH providers (and anything else): records every request.
function fakeHttp(answer: (req: Seen) => Response) {
  const seen: Seen[] = [];
  const f = (async (url: string, init: any) => {
    const req = { url: String(url), body: JSON.parse(init.body), headers: init.headers as Record<string, string> };
    seen.push(req);
    return answer(req);
  }) as unknown as typeof fetch;
  return { f, seen };
}
const nvOk = (n: number) => new Response(JSON.stringify({ data: Array.from({ length: n }, (_, i) => ({ index: i, embedding: vec(i + 1) })), usage: { total_tokens: 5 } }), { status: 200 });
const gmOk = (n: number) => new Response(JSON.stringify({ embeddings: Array.from({ length: n }, (_, i) => ({ values: vec(i + 1) })) }), { status: 200 });
const isGemini = (u: string) => u.includes('generativelanguage.googleapis.com');
const bothOk = (r: Seen) => (isGemini(r.url) ? gmOk(r.body.requests.length) : nvOk(r.body.input.length));
const noSleep = async () => {};

// A fake database for the worker: space state, pending rows, fills.
type Cfg = { alt_provider?: string | null; main_sources?: string[]; alt_sources?: string[]; alt_always?: boolean; pending?: Record<string, any[]>; deferred?: Record<string, boolean> };
function fakeDb(cfg: Cfg = {}) {
  const calls: Array<[string, any]> = [];
  const deferred: Record<string, boolean> = { main: false, alt: false, ...cfg.deferred };
  const pending: Record<string, any[]> = { main: [], alt: [], ...cfg.pending };
  const fills: Array<{ space: string; model: string; ids: string[] }> = [];
  const s = { source_id: 'r1', indexable: true, fp: 'fp1', payload: { row: F.weeklyLegacy(), brand: F.CTX.brand } };
  const rpc = async (fn: string, args: any = {}) => {
    calls.push([fn, args]);
    switch (fn) {
      case 'ai_pipeline_version': return PIPELINE_VERSION;
      case 'ai_embed_model': return DEFAULT_CONFIG.EMBED_MODEL;
      case 'ai_embed_settings': return {
        model: DEFAULT_CONFIG.EMBED_MODEL, alt_provider: cfg.alt_provider === undefined ? 'gemini' : cfg.alt_provider,
        alt_model: MODEL_LABEL.gemini, alt_always: cfg.alt_always ?? true,
        main_sources: cfg.main_sources ?? ['report', 'kb_article', 'tts_article'], alt_sources: cfg.alt_sources ?? ['kb_article', 'tts_article'] };
      case 'ai_vector_ready': return !deferred[args.p_space];
      case 'ai_vector_defer': deferred[args.p_space] = true; return null;
      case 'ai_vector_ok': deferred[args.p_space] = false; return null;
      case 'ai_vector_pending': return pending[args.p_space].splice(0, args.p_limit);
      case 'ai_vector_fill': fills.push({ space: args.p_space, model: args.p_model, ids: args.p_rows.map((r: any) => r.id) }); return args.p_rows.length;
      case 'ai_source_types': return ['report', 'incentive', 'kb_article'];
      case 'ai_ingest_source': return args.p_ids.map((id: string) => ({ ...s, source_id: id }));
      case 'ai_ingest_existing': return [];
      case 'ai_ingest_write': return { ok: true, vector_pending: args.p_chunks.filter((c: any) => !c.embedding && !c.embedding_alt).length };
      case 'ai_ingest_claim': return [];
      case 'ai_ingest_run_start': return 1;
      default: return null;
    }
  };
  return { rpc, calls, deferred, pending, fills };
}
const rows = (n: number, p = 'c') => Array.from({ length: n }, (_, i) => ({ id: `${p}${i}`, content_hash: `h${p}${i}`, embed_text: `text ${p}${i}` }));
const stateCalls = (db: ReturnType<typeof fakeDb>) => db.calls.filter(([f]) => f === 'ai_vector_defer' || f === 'ai_vector_ok').map(([f, a]) => `${f}:${a.p_space}`);

// ── the providers ─────────────────────────────────────────────────────────

test('NVIDIA documents: passage input_type, 1536 dims, float; key 2 on a refused key', async () => {
  const { f, seen } = fakeHttp((r) => (r.headers.authorization === 'Bearer nv1' ? new Response(NO_KEY_REFUSED, { status: 401 }) : nvOk(r.body.input.length)));
  const r = await providerEmbedder('nvidia', { nvidia: 'nv1', nvidia2: 'nv2' }, { fetchImpl: f, sleep: noSleep })!(['a', 'b']);
  assert.equal(r.vectors.length, 2);
  assert.equal(seen[1].url, NVIDIA_EMBED_ENDPOINT);
  assert.deepEqual([seen[1].body.model, seen[1].body.input_type, seen[1].body.encoding_format, seen[1].body.dimensions],
    [NVIDIA_EMBED_MODEL, 'passage', 'float', 1536]);
});

test('Gemini documents: native batchEmbedContents, RETRIEVAL_DOCUMENT, 1536 dims, L2-normalised; questions RETRIEVAL_QUERY', async () => {
  const { f, seen } = fakeHttp((r) => gmOk(r.body.requests.length));
  const r = await providerEmbedder('gemini', { gemini: 'g1' }, { fetchImpl: f, sleep: noSleep })!(['a', 'b', 'c']);
  assert.equal(seen[0].url, `${GEMINI_EMBED_BASE}/models/${GEMINI_EMBED_MODEL}:batchEmbedContents`);
  assert.equal(seen[0].headers['x-goog-api-key'], 'g1');
  assert.deepEqual([seen[0].body.requests.length, seen[0].body.requests[0].taskType, seen[0].body.requests[0].outputDimensionality],
    [3, 'RETRIEVAL_DOCUMENT', 1536]);
  assert.ok(Math.abs(Math.hypot(...r.vectors[0]) - 1) < 1e-9, 'normalised');
  const q = await queryVectors('how do I apply for leave', { gemini: 'g1' }, { altProvider: 'gemini', fetchImpl: f, sleep: noSleep });
  assert.equal(seen.at(-1)!.body.requests[0].taskType, 'RETRIEVAL_QUERY');
  assert.equal(q.alt?.length, 1536);
});

test('the paid OpenAI endpoint is refused by embedTexts itself', async () => {
  let called = 0;
  const f = (async () => { called++; return nvOk(1); }) as unknown as typeof fetch;
  await assert.rejects(embedTexts(['x'], { apiKey: 'sk-paid', endpoint: 'https://api.openai.com/v1/embeddings', fetchImpl: f }),
    (e: any) => e instanceof EmbedError && /free providers only/.test(e.message));
  assert.equal(called, 0);
});

test('the main space is NVIDIA, labelled provider:model, and the labels agree with the providers', () => {
  assert.equal(MAIN_PROVIDER, 'nvidia');
  assert.equal(DEFAULT_CONFIG.EMBED_MODEL, MODEL_LABEL.nvidia);
  assert.equal(MODEL_LABEL.gemini, `gemini:${GEMINI_EMBED_MODEL}`);
});

test('migration 432 labels agree with the code (ai_embed_model, ai_alt_model_for)', () => {
  const sql = fs.readFileSync(path.resolve(AI, '../../../migrations/432_buddy_free_embeddings.sql'), 'utf8');
  assert.ok(sql.includes(`select '${MODEL_LABEL.nvidia}'::text $$`));
  assert.ok(sql.includes(`when 'gemini' then '${MODEL_LABEL.gemini}'`));
  assert.ok(sql.includes(`else '${MODEL_LABEL.nvidia}'`));
});

// ── queries: each space is asked by the provider that filled it ───────────

test('queryVectors: main by NVIDIA (query), second by the configured Gemini; both in parallel; never NVIDIA twice', async () => {
  const { f, seen } = fakeHttp(bothOk);
  const q = await queryVectors('how do we approve samples', { nvidia: 'nv1', gemini: 'g1' }, { altProvider: 'gemini', fetchImpl: f, sleep: noSleep });
  assert.equal(q.main?.length, 1536);
  assert.equal(q.alt?.length, 1536);
  assert.equal(seen.find((s) => s.url === NVIDIA_EMBED_ENDPOINT)!.body.input_type, 'query');
  assert.equal(seen.length, 2);
  const same = fakeHttp(bothOk);
  const q2 = await queryVectors('x', { nvidia: 'nv1', gemini: 'g1' }, { altProvider: 'nvidia', fetchImpl: same.f, sleep: noSleep });
  assert.ok(q2.main && !q2.alt);
  assert.equal(same.seen.length, 1);
});

test('a query vector carries its model label, and a copy of the array does not pretend to', () => {
  const v = tagVector([0.1, 0.2], MODEL_LABEL.nvidia);
  assert.equal(vectorModel(v), MODEL_LABEL.nvidia);
  assert.equal(vectorModel([...v]), null);
  assert.equal(vectorModel(null), null);
});

test('chainEmbedder: both up → both vectors, labelled; NVIDIA down → Gemini serves; both down → keyword-only (down()); OpenAI keys never used', async () => {
  _resetEmbedDown();
  let nvUp = true, gmUp = true;
  const { f, seen } = fakeHttp((r) => (isGemini(r.url) ? (gmUp ? gmOk(r.body.requests.length) : new Response(GEMINI_DAY, { status: 429 }))
    : (nvUp ? nvOk(r.body.input.length) : new Response(QUOTA_NV, { status: 429 }))));
  const env = { nvidiaKey: 'nv1', geminiKey: 'g1', altProvider: 'gemini', fetchImpl: f, openAiKey: 'sk-paid', openAiKeyFallback: 'sk-free' } as any;
  const e1 = chainEmbedder(env);
  const [m, a] = await Promise.all([e1.embed('one'), e1.alt!('one')]);
  assert.deepEqual([vectorModel(m), vectorModel(a)], [MODEL_LABEL.nvidia, MODEL_LABEL.gemini]);
  assert.equal(e1.down(), false);
  _resetEmbedDown(); nvUp = false;
  const e2 = chainEmbedder(env);
  await assert.rejects(e2.embed('two'));
  assert.equal((await e2.alt!('two')).length, 1536);
  assert.equal(e2.down(), false, 'one space up: not keyword-only');
  _resetEmbedDown(); gmUp = false;
  const e3 = chainEmbedder(env);
  await assert.rejects(e3.embed('three'));
  await assert.rejects(e3.alt!('three'));
  assert.equal(e3.down(), true);
  const n = seen.length;
  await assert.rejects(e3.embed('four'));
  await assert.rejects(e3.alt!('four'));
  assert.equal(seen.length, n, 'no call while down');
  assert.ok(!seen.some((s) => s.url.includes('openai.com')), 'the OpenAI keys in the env are never used');
  _resetEmbedDown();
});

test('chainEmbedder: after the window the provider is asked again (it never stays down for good)', async () => {
  _resetEmbedDown();
  let up = false;
  const { f } = fakeHttp((r) => (up ? bothOk(r) : new Response('{"detail":"boom"}', { status: 503 })));
  const e = chainEmbedder({ nvidiaKey: 'nv1', fetchImpl: f } as any);
  await assert.rejects(e.embed('a'));
  up = true;
  _resetEmbedDown();   // the 1-minute window after a 5xx elapsing
  assert.equal((await e.embed('b')).length, 1536);
  _resetEmbedDown();
});

test('searchIndex: asks NVIDIA first and Gemini only if that fails (each vector labelled); both down → keywords', async () => {
  const calls: any[] = [];
  const rpc = async (fn: string, args: any) => { calls.push([fn, args]); return []; };
  let altAsked = 0;
  const main = async () => tagVector(vec(1), MODEL_LABEL.nvidia);
  const alt = async () => { altAsked++; return tagVector(vec(2), MODEL_LABEL.gemini); };
  const r1 = await searchIndex('company', 'apply for leave', {}, { rpc, embed: main, embedAlt: alt });
  const a1 = calls.at(-1)[1];
  assert.deepEqual([a1.p_query_model, a1.p_query_embedding !== null, a1.p_query_embedding_alt, altAsked], [MODEL_LABEL.nvidia, true, undefined, 0]);
  assert.ok(!r1.notes.some((n) => /keyword/.test(n)));
  await searchIndex('company', 'apply for leave', {}, { rpc, embed: async () => { throw new Error('nvidia down'); }, embedAlt: alt });
  const a2 = calls.at(-1)[1];
  assert.deepEqual([a2.p_query_embedding, a2.p_query_model, a2.p_query_model_alt, altAsked], [null, undefined, MODEL_LABEL.gemini, 1]);
  const r3 = await searchIndex('company', 'apply for leave', {}, { rpc, embed: async () => { throw new Error('x'); }, embedAlt: async () => { throw new Error('y'); } });
  const a3 = calls.at(-1)[1];
  assert.deepEqual([a3.p_query_embedding, a3.p_query_embedding_alt], [null, undefined]);
  assert.ok(r3.notes.some((n) => /keyword/.test(n)));
});

test('migration 432: an unlabelled or other-model query vector is ignored by ai_search (strict guard); the weights keep keywords a tiebreaker', () => {
  const sql = fs.readFileSync(path.resolve(AI, '../../../migrations/432_buddy_free_embeddings.sql'), 'utf8');
  assert.match(sql, /if p_query_embedding is not null and p_query_model is distinct from v_model then p_query_embedding := null/);
  assert.match(sql, /if p_query_embedding_alt is not null and p_query_model_alt is distinct from v_amodel then p_query_embedding_alt := null/);
  assert.match(sql, /W_SEM constant float := 20.0;/);
  assert.match(sql, /W_KW  constant float := 1.0;/);
});

// ── the worker: spaces, privacy, states ───────────────────────────────────

const item = { id: 1, source_type: 'report', source_id: 'r1', op: 'upsert' as const, attempts: 1 };

test('ingest: a free-provider type gets a MAIN vector (NVIDIA) and, if the second provider may see it, a second one; each labelled', async () => {
  const db = fakeDb({ main_sources: ['report'], alt_sources: ['report'] });
  const { f, seen } = fakeHttp(bothOk);
  const st = emptyStats();
  await processBatch([item], { rpc: db.rpc, workerId: 'w', ...O,
    embed: providerEmbedder('nvidia', { nvidia: 'nv' }, { fetchImpl: f, sleep: noSleep }),
    embedAlt: providerEmbedder('gemini', { gemini: 'g' }, { fetchImpl: f, sleep: noSleep }), sleep: noSleep }, st);
  const w = db.calls.find(([fn]) => fn === 'ai_ingest_write')![1];
  assert.ok(w.p_chunks.every((c: any) => c.embedding?.length === 1536 && c.embedding_alt?.length === 1536 && c.embed_model_alt === MODEL_LABEL.gemini));
  assert.equal(seen.filter((s) => s.url === NVIDIA_EMBED_ENDPOINT).length, 1);
  assert.equal(seen.filter((s) => isGemini(s.url)).length, 1);
  assert.deepEqual([st.succeeded, st.alt_embedded > 0, st.vector_pending], [1, true, 0]);
});

test('PRIVACY: incentive (pay data) is never sent to a free provider, and a type missing from a provider\'s list is not sent to THAT provider', async () => {
  const db = fakeDb({ main_sources: ['kb_article', 'report'], alt_sources: ['kb_article'] });   // report: NVIDIA only
  const { f, seen } = fakeHttp(bothOk);
  const mk = () => ({ rpc: db.rpc, workerId: 'w', ...O, sleep: noSleep,
    embed: providerEmbedder('nvidia', { nvidia: 'nv' }, { fetchImpl: f, sleep: noSleep }),
    embedAlt: providerEmbedder('gemini', { gemini: 'g' }, { fetchImpl: f, sleep: noSleep }) });
  // an incentive-typed document (the report extractor stands in for its text; the type is what the privacy rule looks at)
  const asIncentive = { incentive: { extractor: reportExtractor, fetch: async (ids: string[]) => ids.map((id) => ({ source_id: id, indexable: true, fp: 'x', payload: { row: F.weeklyLegacy(), ctx: F.CTX } })) } };
  await processBatch([{ ...item, source_type: 'incentive' }], { ...mk(), sources: asIncentive as any }, emptyStats());
  assert.equal(seen.length, 0, 'no request at all for incentive');
  const w1 = db.calls.find(([fn]) => fn === 'ai_ingest_write')![1];
  assert.ok(w1.p_chunks.every((c: any) => c.embedding === null && !('embedding_alt' in c)));
  seen.length = 0;
  await processBatch([item], mk(), emptyStats());
  assert.ok(seen.length > 0 && seen.every((s) => s.url === NVIDIA_EMBED_ENDPOINT), 'report goes to NVIDIA only');
});

test('a space whose provider fails keeps the other: chunks are written with the vector that worked', async () => {
  const db = fakeDb({ main_sources: ['report'], alt_sources: ['report'] });
  const { f } = fakeHttp((r) => (isGemini(r.url) ? new Response(GEMINI_DAY, { status: 429 }) : nvOk(r.body.input.length)));
  const st = emptyStats();
  await processBatch([item], { rpc: db.rpc, workerId: 'w', ...O, sleep: noSleep,
    embed: providerEmbedder('nvidia', { nvidia: 'nv' }, { fetchImpl: f, sleep: noSleep }),
    embedAlt: providerEmbedder('gemini', { gemini: 'g' }, { fetchImpl: f, sleep: noSleep }) }, st);
  const w = db.calls.find(([fn]) => fn === 'ai_ingest_write')![1];
  assert.ok(w.p_chunks.every((c: any) => c.embedding?.length === 1536 && !('embedding_alt' in c)));
  assert.deepEqual([st.spaces_down, st.alt_issue, st.provider_issue], [['alt'], 'limit', null]);
  assert.equal(st.failed, 0);
});

test('deferral lengths: the provider\'s own wait (at most 6 h); a quota/auth error 30 min; a transient error 2 min', () => {
  const e = (status: number, body: string) => Object.assign(new Error(`embeddings HTTP ${status}: ${body}`), { status });
  assert.equal(deferSeconds(e(429, GEMINI_DAY), 'limit'), 21_600);
  assert.equal(deferSeconds(e(429, GEMINI_MINUTE), null), 60);   // 29.9 s + 5 s, never under a minute
  assert.equal(deferSeconds(e(401, NO_KEY_REFUSED), 'auth'), PROVIDER_DEFER_SECONDS);
  assert.equal(deferSeconds(e(503, 'upstream'), null), TRANSIENT_DEFER_SECONDS);
});

test('backfill 429 → deferred; the next run after the wait recovers, fills, and clears the state (never stuck down)', async () => {
  const db = fakeDb({ pending: { main: rows(3) } });
  let blocked = true;
  const { f } = fakeHttp((r) => (blocked ? new Response(QUOTA_NV, { status: 429 }) : nvOk(r.body.input.length)));
  const make = () => ({ rpc: db.rpc, workerId: 'w', ...O, sleep: noSleep, embed: providerEmbedder('nvidia', { nvidia: 'nv' }, { fetchImpl: f, sleep: noSleep }) });
  const s1 = emptyStats();
  await backfillVectors(make(), s1, () => true);
  assert.deepEqual([s1.spaces_down, db.fills.length, db.deferred.main], [['main'], 0, true]);
  assert.deepEqual(stateCalls(db), ['ai_vector_defer:main']);
  db.pending.main = rows(3);
  const before = db.calls.length;
  await backfillVectors(make(), emptyStats(), () => true);
  assert.ok(!db.calls.slice(before).some(([fn]) => fn === 'ai_vector_pending'), 'a deferred space is left alone');
  db.deferred.main = false; blocked = false;   // the wait is over and the provider works
  const s3 = emptyStats();
  await backfillVectors(make(), s3, () => true);
  assert.deepEqual([s3.backfilled_primary, db.fills.at(-1)?.space, db.fills.at(-1)?.model, db.deferred.main], [3, 'main', DEFAULT_CONFIG.EMBED_MODEL, false]);
  assert.equal(stateCalls(db).at(-1), 'ai_vector_ok:main', 'the first success clears the old state');
});

test('401 (key refused): NVIDIA key 2 is tried; if both are refused the space is deferred 30 min, and the other space still fills', async () => {
  const db = fakeDb({ pending: { main: rows(2, 'm'), alt: rows(2, 'a') } });
  const { f, seen } = fakeHttp((r) => (isGemini(r.url) ? gmOk(r.body.requests.length) : new Response(NO_KEY_REFUSED, { status: 401 })));
  const st = emptyStats();
  await backfillVectors({ rpc: db.rpc, workerId: 'w', ...O, sleep: noSleep,
    embed: providerEmbedder('nvidia', { nvidia: 'a', nvidia2: 'b' }, { fetchImpl: f, sleep: noSleep }),
    embedAlt: providerEmbedder('gemini', { gemini: 'g' }, { fetchImpl: f, sleep: noSleep }) }, st, () => true);
  assert.equal(seen.filter((s) => s.url === NVIDIA_EMBED_ENDPOINT).length, 2, 'both NVIDIA keys tried once');
  const d = db.calls.find(([fn]) => fn === 'ai_vector_defer')![1];
  assert.deepEqual([d.p_space, d.p_seconds, st.provider_issue], ['main', PROVIDER_DEFER_SECONDS, 'auth']);
  assert.deepEqual([st.backfilled_alt, db.fills.map((x) => x.space)], [2, ['alt']]);
});

test('a provider that refuses ONE bad chunk does not block the rest: the batch is halved until the bad row stands alone', async () => {
  const db = fakeDb({ pending: { main: rows(5) } });
  const { f, seen } = fakeHttp((r) => (r.body.input.includes('text c2') ? new Response('{"detail":"input too long"}', { status: 400 }) : nvOk(r.body.input.length)));
  const st = emptyStats();
  await backfillVectors({ rpc: db.rpc, workerId: 'w', ...O, sleep: noSleep, embed: providerEmbedder('nvidia', { nvidia: 'nv' }, { fetchImpl: f, sleep: noSleep }) }, st, () => true);
  assert.deepEqual(db.fills.flatMap((x) => x.ids).sort(), ['c0', 'c1', 'c3', 'c4']);
  assert.deepEqual([st.skipped_rows, st.spaces_down, db.deferred.main], [1, [], false], 'a refused input is not an outage');
  assert.ok(seen.length >= 3);
});

test('no API key for a provider: the space is deferred with a visible reason (retried hourly), the other still works', async () => {
  const db = fakeDb({ pending: { main: rows(2) } });
  const { f } = fakeHttp(bothOk);
  const stats = await runWorker({ rpc: db.rpc, keys: { nvidia: 'nv' }, fetchImpl: f, sleep: noSleep, recordRun: false, checkPipeline: false, workerId: 'w' });
  const d = db.calls.find(([fn]) => fn === 'ai_vector_defer')![1];
  assert.deepEqual([d.p_space, d.p_seconds, /no API key configured for gemini/.test(d.p_error)], ['alt', NO_KEY_DEFER_SECONDS, true]);
  assert.equal(stats.backfilled_primary, 2);
});

test('REGRESSION: embedders are built from keys AFTER the settings are read; a working provider is never marked down for lack of an embedder', async () => {
  const db = fakeDb({ pending: { main: rows(2, 'm'), alt: rows(2, 'a') } });
  const { f } = fakeHttp(bothOk);
  const stats = await runWorker({ rpc: db.rpc, keys: { nvidia: 'nv', gemini: 'g' }, fetchImpl: f, sleep: noSleep, recordRun: false, checkPipeline: false, workerId: 'w' });
  assert.deepEqual([stats.backfilled_primary, stats.backfilled_alt, stats.spaces_down], [2, 2, []]);
  assert.ok(!db.calls.some(([fn]) => fn === 'ai_vector_defer'));
});

test('a space deferred in the database is not asked, the other is; alt_provider null switches the second space off', async () => {
  const db = fakeDb({ pending: { main: rows(2, 'm'), alt: rows(2, 'a') }, deferred: { alt: true } });
  const { f, seen } = fakeHttp(bothOk);
  await runWorker({ rpc: db.rpc, keys: { nvidia: 'nv', gemini: 'g' }, fetchImpl: f, sleep: noSleep, recordRun: false, checkPipeline: false, workerId: 'w' });
  assert.ok(!seen.some((s) => isGemini(s.url)));
  assert.ok(!db.calls.some(([fn, a]) => fn === 'ai_vector_pending' && a.p_space === 'alt'));
  const off = fakeDb({ alt_provider: null, pending: { main: rows(1), alt: rows(1, 'a') } });
  const h = fakeHttp(bothOk);
  await runWorker({ rpc: off.rpc, keys: { nvidia: 'nv', gemini: 'g' }, fetchImpl: h.f, sleep: noSleep, recordRun: false, checkPipeline: false, workerId: 'w' });
  assert.ok(!h.seen.some((s) => isGemini(s.url)));
});

test('pacing: Gemini waits for its per-minute allowance between batches, and only if the time budget has room', async () => {
  assert.equal(paceMs('gemini', 40, 12_000), 30_000);      // 40 inputs at 80/min
  assert.equal(paceMs('nvidia', 96, 40_000), 1_200);   // a gap of 1.2 s: about 50 requests a minute
  let t = 0;
  const waits: number[] = [];
  const db = fakeDb({ pending: { alt: rows(100, 'a') } });
  const { f } = fakeHttp(bothOk);
  const emb = providerEmbedder('gemini', { gemini: 'g' }, { fetchImpl: f, sleep: noSleep, now: () => t })!;
  const o = { rpc: db.rpc, workerId: 'w', ...O, embedAlt: emb, sleep: async (ms: number) => { waits.push(ms); t += ms; } };
  const st = emptyStats();
  await backfillVectors(o, st, (need = 0) => t + need < 60_000);
  assert.ok(waits.length >= 1 && waits.every((w) => w > 0 && w <= 30_000), JSON.stringify(waits));
  assert.ok(st.backfilled_alt >= 80, String(st.backfilled_alt));
  assert.ok(st.backfilled_alt < 100, 'stopped by the budget, not by finishing');
});

test('end to end: runIngest with keys only → NVIDIA/Gemini requests only, nothing to openai.com', async () => {
  const db = fakeDb({ pending: { main: rows(3, 'm'), alt: rows(3, 'a') } });
  const { f, seen } = fakeHttp(bothOk);
  const r = await runIngest('drain', { rpc: db.rpc, keys: { nvidia: 'nv', gemini: 'g' }, fetchImpl: f, sleep: noSleep });
  assert.equal(r.stats?.backfilled_primary, 3);
  assert.equal(r.stats?.backfilled_alt, 3);
  assert.ok(seen.length >= 2 && seen.every((s) => !s.url.includes('openai.com')));
});

// ── no path to the paid API ───────────────────────────────────────────────

test('no retrieval/embedding source file names api.openai.com, and the paid reranker and OpenAI embedder are gone', () => {
  const dirs = ['retrieval', 'ingest'].map((d) => path.join(AI, d));
  const files = [path.join(AI, 'embedder.ts'), path.join(AI, 'agent/server.ts'), path.resolve(AI, '../../ai-ingest/index.ts'),
    ...dirs.flatMap((d) => fs.readdirSync(d).filter((n) => n.endsWith('.ts')).map((n) => path.join(d, n)))];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    assert.ok(!/api\.openai\.com/.test(src), `${file} names api.openai.com`);
    assert.ok(!/openAiReranker|openAiQueryEmbedder|openAiEmbedder/.test(src), `${file} still uses an OpenAI embedder/reranker`);
  }
  assert.ok(!/OPEN_AI_API_KEY/.test(fs.readFileSync(path.resolve(AI, '../../ai-ingest/index.ts'), 'utf8')), 'ai-ingest does not read the OpenAI secrets');
});

test('Boss decision 2026-11-03: Gemini may get reports, and pay data (incentive) is on no provider list', () => {
  const sql = fs.readFileSync(path.resolve(AI, '../../../migrations/432_buddy_free_embeddings.sql'), 'utf8');
  const m = sql.match(/gemini_provider_sources text\[\] not null\s+default array\[([^\]]+)\]/);
  assert.ok(m, 'the gemini_provider_sources default is in the migration');
  const list = m![1].replace(/'/g, '').split(',').map((x) => x.trim());
  assert.ok(list.includes('report'), 'reports are allowed on Gemini');
  assert.ok(!list.includes('incentive'), 'incentive is never allowed');
  assert.ok(!/array\[[^\]]*'incentive'[^\]]*\]\s*(;|\))\s*\n\s*--?\s*free/i.test(sql));
});
