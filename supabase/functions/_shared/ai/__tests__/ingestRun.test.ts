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
