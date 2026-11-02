// The ai-ingest entry (ingest/run.ts): mode parsing, sweep-then-drain, and the
// time budget. Pure: a fake Rpc, no database, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, PIPELINE_VERSION } from '../config.ts';
import { parseMode, runIngest } from '../ingest/run.ts';

test('parseMode: no body / {} / {mode:drain} → drain; {mode:sweep} → sweep; anything else → null', () => {
  assert.equal(parseMode(null), 'drain');
  assert.equal(parseMode(undefined), 'drain');
  assert.equal(parseMode({}), 'drain');
  assert.equal(parseMode({ mode: 'drain' }), 'drain');
  assert.equal(parseMode({ mode: 'sweep' }), 'sweep');
  for (const bad of [{ mode: 'backfill' }, { mode: 1 }, [], 'sweep', 3]) assert.equal(parseMode(bad), null, JSON.stringify(bad));
});

// Records every RPC; the queue is empty, so a drain is one claim.
function fakeRpc(sweepResult: unknown = { status: 'swept', enqueued_total: 0 }) {
  const calls: string[] = [];
  const rpc = async (fn: string) => {
    calls.push(fn);
    if (fn === 'ai_pipeline_version') return PIPELINE_VERSION;
    if (fn === 'ai_embed_model') return DEFAULT_CONFIG.EMBED_MODEL;
    if (fn === 'ai_run_ingestion') return sweepResult;
    if (fn === 'ai_ingest_run_start') return 1;
    if (fn === 'ai_ingest_claim') return [];
    return null;
  };
  return { rpc, calls };
}
const embed = async () => { throw new Error('nothing should be embedded'); };

test('drain: never calls ai_run_ingestion; claims once on an empty queue', async () => {
  const f = fakeRpc();
  const r = await runIngest('drain', { rpc: f.rpc, embed });
  assert.equal(r.mode, 'drain');
  assert.equal(r.sweep, undefined);
  assert.equal(r.stats?.claimed, 0);
  assert.ok(!f.calls.includes('ai_run_ingestion'));
  assert.equal(f.calls.filter((c) => c === 'ai_ingest_claim').length, 1);
});

test('sweep: ai_run_ingestion first (its result is returned, guards included), then a drain', async () => {
  const f = fakeRpc({ status: 'too_soon', next_allowed_at: 'x' });
  const r = await runIngest('sweep', { rpc: f.rpc, embed });
  assert.deepEqual(r.sweep, { status: 'too_soon', next_allowed_at: 'x' });
  assert.equal(f.calls[0], 'ai_run_ingestion');
  assert.ok(f.calls.includes('ai_ingest_claim'));
});

test('time budget: a sweep that used the whole budget skips the drain', async () => {
  let t = 0;
  const f = fakeRpc();
  const slow = async (fn: string) => { if (fn === 'ai_run_ingestion') t += 5_000; return f.rpc(fn); };
  const r = await runIngest('sweep', { rpc: slow, embed, timeBudgetMs: 5_000, now: () => t });
  assert.equal(r.skipped_drain, true);
  assert.ok(!f.calls.includes('ai_ingest_claim'));
});

test('the default budget stays under the edge wall-clock limit (150 s) with room for one overrunning batch', () => {
  assert.ok(DEFAULT_CONFIG.WORKER_TIME_BUDGET_MS <= 110_000, String(DEFAULT_CONFIG.WORKER_TIME_BUDGET_MS));
});

// Production passes only KEYS (altKeys), never a built embedder. The worker builds the NVIDIA
// fallback itself, after reading settings. It used to build it and then keep it marked "down"
// (the state was computed before the embedder existed), so with OpenAI out of credits NOTHING
// was embedded for a month: 1,791 chunks waited with a working fallback key sitting unused.
test('altKeys only: the fallback provider embeds the backlog when OpenAI has no credits', async () => {
  const filled: Array<{ space: string; n: number }> = [];
  const calls: string[] = [];
  const pending = [{ id: 'c1', content_hash: 'h1', embed_text: 'one' }, { id: 'c2', content_hash: 'h2', embed_text: 'two' }];
  let altServed = false;
  const rpc = async (fn: string, args: any = {}) => {
    calls.push(fn);
    if (fn === 'ai_pipeline_version') return PIPELINE_VERSION;
    if (fn === 'ai_embed_model') return DEFAULT_CONFIG.EMBED_MODEL;
    if (fn === 'ai_ingest_claim') return [];
    if (fn === 'ai_embed_settings') return { alt_always: true, free_sources: ['report'], alt_provider: 'nvidia', alt_model: 'nvidia:test' };
    if (fn === 'ai_vector_ready') return true;
    if (fn === 'ai_vector_pending') {
      if (args.p_space === 'alt' && !altServed) { altServed = true; return pending; }
      return [];
    }
    if (fn === 'ai_vector_fill') { filled.push({ space: args.p_space, n: args.p_rows.length }); return args.p_rows.length; }
    return null;
  };
  const vec = Array.from({ length: DEFAULT_CONFIG.EMBED_DIMS }, () => 0.1);
  const nvidia = async (_url: any, init: any) => {
    const input = JSON.parse(init.body).input as string[];
    return new Response(JSON.stringify({ data: input.map((_, i) => ({ index: i, embedding: vec })), usage: { prompt_tokens: 2, total_tokens: 2 } }), { status: 200 });
  };
  const openAiNoCredits = async () => { throw Object.assign(new Error('embeddings HTTP 429: insufficient_quota credit_balance_exhausted'), { status: 429 }); };
  // runIngest does not forward a fetch override, so the NVIDIA call is stubbed globally for this test.
  const realFetch = globalThis.fetch;
  globalThis.fetch = nvidia as any;
  try {
    const r = await runIngest('drain', { rpc, embed: openAiNoCredits, altKeys: { nvidia: 'nv-key' } });
    assert.deepEqual(filled, [{ space: 'alt', n: 2 }], 'the two pending chunks were embedded on the fallback');
    assert.equal(r.stats?.backfilled_alt, 2);
  } finally { globalThis.fetch = realFetch; }
});

test('altKeys only, fallback deferred (an earlier quota/auth problem): it is left alone, not hammered', async () => {
  const calls: string[] = [];
  const rpc = async (fn: string, args: any = {}) => {
    calls.push(fn + (args.p_space ? `:${args.p_space}` : ''));
    if (fn === 'ai_pipeline_version') return PIPELINE_VERSION;
    if (fn === 'ai_embed_model') return DEFAULT_CONFIG.EMBED_MODEL;
    if (fn === 'ai_ingest_claim') return [];
    if (fn === 'ai_embed_settings') return { alt_always: true, free_sources: ['report'], alt_provider: 'nvidia', alt_model: 'nvidia:test' };
    if (fn === 'ai_vector_ready') return args.p_space !== 'alt';      // alt is in its retry wait
    if (fn === 'ai_vector_pending') return [];
    return null;
  };
  await runIngest('drain', { rpc, embed: async () => { throw new Error('unused'); }, altKeys: { nvidia: 'nv-key' } });
  assert.ok(!calls.includes('ai_vector_pending:alt'), 'a deferred alt space is not asked for work');
});
