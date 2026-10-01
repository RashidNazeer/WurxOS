// mig 406: the NVIDIA alt vector space, pending vectors and their backfill. Faked providers only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALT_EMBED_MODEL, NVIDIA_EMBED_ENDPOINT, NVIDIA_EMBED_MODEL, queryVectors } from '../embedder.ts';
import { DEFAULT_CONFIG, PIPELINE_VERSION } from '../config.ts';
import { backfillVectors, emptyStats, nvidiaEmbedder, processBatch, PROVIDER_DEFER_SECONDS } from '../ingest/worker.ts';
import * as F from './fixtures/reports.ts';

const O = { pipelineVersion: PIPELINE_VERSION, model: DEFAULT_CONFIG.EMBED_MODEL };
const NO_CREDITS = JSON.stringify({ error: { message: 'Your credit balance is exhausted.', type: 'insufficient_quota', code: 'credit_balance_exhausted' } });
const vec = (x: number) => Array.from({ length: 1536 }, (_, i) => (i === 0 ? x : 0.001));

// A fake HTTP API: records requests, answers from `answer(url, body, key)`.
function fakeFetch(answer: (url: string, body: any, key: string) => Response) {
  const seen: Array<{ url: string; body: any; key: string }> = [];
  const f = (async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    const key = String(init.headers.authorization).replace('Bearer ', '');
    seen.push({ url, body, key });
    return answer(url, body, key);
  }) as unknown as typeof fetch;
  return { f, seen };
}
const ok = (n: number) => new Response(JSON.stringify({ data: Array.from({ length: n }, (_, i) => ({ index: i, embedding: vec(i + 1) })), usage: { total_tokens: 3 } }), { status: 200 });

test('NVIDIA embedder: passage input_type, 1536 dims, float; key 2 on an account problem', async () => {
  const { f, seen } = fakeFetch((_u, b, key) => (key === 'nv1' ? new Response('{"detail":"invalid api key"}', { status: 401 }) : ok(b.input.length)));
  const r = await nvidiaEmbedder(['nv1', 'nv2'], f)(['a', 'b']);
  assert.equal(r.vectors.length, 2);
  assert.equal(r.vectors[0].length, 1536);
  assert.deepEqual(seen.map((s) => s.key), ['nv1', 'nv2']);
  assert.equal(seen[1].url, NVIDIA_EMBED_ENDPOINT);
  assert.deepEqual([seen[1].body.model, seen[1].body.input_type, seen[1].body.encoding_format, seen[1].body.dimensions],
    [NVIDIA_EMBED_MODEL, 'passage', 'float', 1536]);
});

test('queryVectors: OpenAI out of credits → an NVIDIA query vector (input_type query); OpenAI fine → no alt call', async () => {
  const down = fakeFetch((u, b) => (u.includes('openai.com') ? new Response(NO_CREDITS, { status: 429 }) : ok(b.input.length)));
  const q = await queryVectors('how do we approve samples', { openai: 'o1', openaiFallback: 'o2', nvidia: 'nv1' }, { fetchImpl: down.f });
  assert.equal(q.primary, null);
  assert.equal(q.alt?.length, 1536);
  assert.equal(q.issues[0].issue, 'quota');
  const nv = down.seen.find((s) => s.url === NVIDIA_EMBED_ENDPOINT)!;
  assert.equal(nv.body.input_type, 'query');
  assert.equal(down.seen.filter((s) => s.url.includes('openai.com')).length, 2, 'both OpenAI keys tried');
  const up = fakeFetch((_u, b) => ok(b.input.length));
  const q2 = await queryVectors('x', { openai: 'o1', nvidia: 'nv1' }, { fetchImpl: up.f });
  assert.ok(q2.primary && !q2.alt);
  assert.ok(!up.seen.some((s) => s.url === NVIDIA_EMBED_ENDPOINT));
});

// The worker with a fake database.
function fakeRpc(o: { free: string[]; pending?: any[] } = { free: ['report'] }) {
  const calls: Array<[string, any]> = [];
  const s = { source_id: 'r1', indexable: true, fp: 'fp1', payload: { row: F.weeklyLegacy(), brand: F.CTX.brand } };
  const rpc = async (fn: string, args: any = {}) => {
    calls.push([fn, args]);
    if (fn === 'ai_source_types') return ['report'];
    if (fn === 'ai_ingest_source') return args.p_ids.map((id: string) => ({ ...s, source_id: id }));
    if (fn === 'ai_ingest_existing') return [];
    if (fn === 'ai_embed_settings') return { alt_always: false, free_sources: o.free };
    if (fn === 'ai_ingest_write') return { ok: true, vector_pending: args.p_chunks.filter((c: any) => !c.embedding).length };
    if (fn === 'ai_vector_pending') return args.p_space === 'primary' ? (o.pending ?? []) : [];
    if (fn === 'ai_vector_fill') return args.p_rows.length;
    return null;
  };
  return { rpc, calls };
}
const item = { id: 1, source_type: 'report', source_id: 'r1', op: 'upsert' as const, attempts: 1 };
const noCredits = async () => { const e: any = new Error(`embeddings HTTP 429: ${NO_CREDITS}`); e.status = 429; throw e; };
const altOk = async (t: string[]) => ({ vectors: t.map(() => vec(9)), tokens: 0 });

test('OpenAI down: a free-provider type gets an NVIDIA vector (embed_model_alt labelled); not listed → no alt, still written', async () => {
  const a = fakeRpc({ free: ['report'] });
  const st = emptyStats();
  await processBatch([item], { rpc: a.rpc, workerId: 'w', ...O, embed: noCredits, embedAlt: altOk }, st);
  const w = a.calls.find(([f]) => f === 'ai_ingest_write')![1];
  assert.ok(w.p_chunks.every((c: any) => c.embedding === null && c.embedding_alt?.length === 1536 && c.embed_model_alt === ALT_EMBED_MODEL));
  assert.equal(ALT_EMBED_MODEL, 'nvidia:llama-nemotron-embed-vl-1b-v2');
  assert.deepEqual([st.succeeded, st.failed, st.provider_issue, st.alt_embedded > 0, st.vector_pending > 0], [1, 0, 'quota', true, true]);
  // the privacy list: report not allowed → never sent to NVIDIA
  const b = fakeRpc({ free: ['kb_article'] });
  let sent = 0;
  await processBatch([item], { rpc: b.rpc, workerId: 'w', ...O, embed: noCredits, embedAlt: async (t) => { sent++; return altOk(t); } }, emptyStats());
  assert.equal(sent, 0);
  assert.ok(b.calls.find(([f]) => f === 'ai_ingest_write')![1].p_chunks.every((c: any) => c.embedding === null && !('embedding_alt' in c)));
});

test('backfill: pending vectors filled when OpenAI works; deferred (no fill) on an account problem', async () => {
  const pending = [{ id: 'c1', content_hash: 'h1', embed_text: 'one' }, { id: 'c2', content_hash: 'h2', embed_text: 'two' }];
  const a = fakeRpc({ free: [], pending });
  const st = emptyStats();
  await backfillVectors({ rpc: a.rpc, workerId: 'w', ...O, embed: async (t) => ({ vectors: t.map(() => vec(1)), tokens: 4 }) }, st, () => true);
  const fill = a.calls.find(([f]) => f === 'ai_vector_fill')![1];
  assert.deepEqual([fill.p_space, fill.p_model, fill.p_rows.map((r: any) => r.id)], ['primary', DEFAULT_CONFIG.EMBED_MODEL, ['c1', 'c2']]);
  assert.equal(st.backfilled_primary, 2);
  const b = fakeRpc({ free: [], pending });
  await backfillVectors({ rpc: b.rpc, workerId: 'w', ...O, embed: noCredits }, emptyStats(), () => true);
  assert.ok(!b.calls.some(([f]) => f === 'ai_vector_fill'));
  const d = b.calls.find(([f]) => f === 'ai_vector_defer')![1];
  assert.deepEqual([d.p_space, d.p_seconds], ['primary', PROVIDER_DEFER_SECONDS]);
});
