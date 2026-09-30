// QA 2026-10-01 F2 + F3: OpenAI account problems (no credits, a refused key)
// and the usage rows. Faked responses only: the dev key has no credits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, PIPELINE_VERSION } from '../config.ts';
import { embedTexts, EmbedError } from '../embedder.ts';
import { emptyStats, processBatch, PROVIDER_DEFER_SECONDS, runWorker } from '../ingest/worker.ts';
import { LlmError, respond } from '../llm/openai.ts';
import { providerAccountIssue, providerIssueMessage } from '../providerErrors.ts';
import { pricesFrom, UsageMeter } from '../prices.ts';
import { runTurn, usageRows } from '../agent/core.ts';
import * as F from './fixtures/reports.ts';

const QUOTA_BODY = JSON.stringify({ error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', code: 'insufficient_quota' } });
const NO_CREDITS_BODY = JSON.stringify({ error: { message: 'You have no credits remaining.', type: 'insufficient_quota' } });
const KEY_BODY = JSON.stringify({ error: { message: 'Incorrect API key provided: sk-...xyz.', code: 'invalid_api_key' } });
const res = (status: number, body: string) => new Response(body, { status, headers: { 'content-type': 'application/json' } });

test('classification: quota (either wording), refused key, and ordinary errors', () => {
  assert.equal(providerAccountIssue(new LlmError(`model HTTP 429: ${QUOTA_BODY}`, 429)), 'quota');
  assert.equal(providerAccountIssue(new EmbedError(`embeddings HTTP 429: ${NO_CREDITS_BODY}`, false, 429)), 'quota');
  assert.equal(providerAccountIssue(new LlmError(`model HTTP 401: ${KEY_BODY}`, 401)), 'auth');
  assert.equal(providerAccountIssue(new LlmError('model HTTP 429: {"error":{"code":"rate_limit_exceeded"}}', 429)), null);
  assert.equal(providerAccountIssue(new Error('socket hang up')), null);
});

test('messages: plain for everyone, actionable for the Boss', () => {
  assert.equal(providerIssueMessage('quota', 'apc'), "Buddy can't reach its AI service right now: the AI account needs attention. Please tell the Boss.");
  assert.equal(providerIssueMessage('auth', 'ol'), providerIssueMessage('quota', 'apc'));
  assert.equal(providerIssueMessage('quota', 'boss'), 'OpenAI credits are used up: top up the OpenAI account (platform.openai.com → Billing).');
  assert.match(providerIssueMessage('auth', 'boss'), /API key/);
});

test('no retry on a quota 429 (model and embeddings); a real rate limit is still retried', async () => {
  let calls = 0;
  const quota = async () => { calls++; return res(429, QUOTA_BODY); };
  await assert.rejects(respond({ apiKey: 'k', model: 'gpt-5.4-mini', instructions: 'i', input: [], fetchImpl: quota as any }), /insufficient_quota/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(embedTexts(['x'], { apiKey: 'k', fetchImpl: quota as any, sleep: async () => {} }), (e: any) => e instanceof EmbedError && !e.retryable);
  assert.equal(calls, 1);
  calls = 0;
  const limited = async () => { calls++; return res(429, '{"error":{"code":"rate_limit_exceeded"}}'); };
  await assert.rejects(embedTexts(['x'], { apiKey: 'k', fetchImpl: limited as any, sleep: async () => {}, maxRetries: 2 }));
  assert.equal(calls, 3);
});

// ── the turn ────────────────────────────────────────────────────────────────

function turnDb() {
  const inserts: Record<string, any[]> = {};
  const updates: any[] = [];
  let seq = 0;
  const tables: Record<string, any[]> = { ai_assistant_config: [{ id: 1, persona: '', model: 'gpt-5.4-mini', enabled: true, retrieval: {} }] };
  const from = (table: string) => {
    let op = 'select'; let payload: any = null; const where: any = {};
    const q: any = {
      select: () => q, eq: (k: string, v: any) => { if (op === 'update') where[k] = v; return q; },
      neq: () => q, lt: () => q, gte: () => q, in: () => q, order: () => q, limit: () => q,
      insert: (p: any) => { op = 'insert'; payload = [].concat(p).map((r: any) => ({ id: `${table}-${++seq}`, ...r })); (inserts[table] ??= []).push(...payload); return q; },
      update: (p: any) => { op = 'update'; payload = p; return q; },
      maybeSingle: async () => ({ data: (tables[table] ?? [])[0] ?? null, error: null }),
      single: async () => ({ data: op === 'insert' ? payload[0] : null, error: null }),
      then: (ok: any, bad: any) => {
        if (op === 'update') { updates.push({ table, set: payload, where }); for (const r of inserts[table] ?? []) if (Object.entries(where).every(([k, v]) => r[k] === v)) Object.assign(r, payload); }
        return Promise.resolve({ data: op === 'insert' ? payload : [], error: null, count: 0 }).then(ok, bad);
      },
    };
    return q;
  };
  return { from, rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'missing' } }), inserts, updates };
}

test('a turn hit by no credits: plain message for a user, billing hint for the Boss, flagged, row = error', async () => {
  for (const role of ['apc', 'boss']) {
    const db = turnDb();
    const events: any[] = [];
    const llm = async () => { throw new LlmError(`model HTTP 429: ${NO_CREDITS_BODY}`, 429); };
    await runTurn({ userId: 'u1', role, message: 'hi' }, {
      admin: db, searchRpc: async () => [], asUser: 'u1', apiKey: 'k', embed: async () => [0.1], llm, requestId: 'r1',
    }, (e) => events.push(e));
    const shown = events.find((e) => e.error).error;
    assert.equal(shown, providerIssueMessage('quota', role));
    const reply = db.inserts.ai_messages.find((m: any) => m.role === 'assistant');
    assert.deepEqual([reply.status, reply.meta.error], ['error', shown]);
    const log = db.inserts.ai_request_log[0];
    assert.deepEqual([log.flags.provider_quota, log.flags.provider_issue], [true, 'quota']);
    assert.ok(!log.flags.deadline_hit);
  }
  assert.ok(!/credit|OpenAI|billing/i.test(providerIssueMessage('quota', 'apc')), 'no technical detail for users');
});

test('F2: every ai_usage_log row carries every column (no NULL from a bulk insert)', () => {
  const m = new UsageMeter();
  m.onRerank('gpt-5.4-mini')({ input_tokens: 10, output_tokens: 2 });
  m.onEmbed('text-embedding-3-small')(7);
  const rows = usageRows(m, pricesFrom(null), { user_id: 'u', request_id: 'r' });
  const keys = rows.map((r) => Object.keys(r).sort().join(','));
  assert.equal(new Set(keys).size, 1, keys.join(' | '));
  for (const r of rows) for (const k of ['tokens_in', 'tokens_cached', 'tokens_out', 'calls', 'est_cost_usd']) assert.equal(typeof r[k], 'number', `${r.kind}.${k}`);
  assert.equal(rows.find((r) => r.kind === 'embed_query')!.tokens_cached, 0);
});

// ── the ingest worker ───────────────────────────────────────────────────────

test('ingest: no credits → items deferred (attempt kept, not failed), run stops', async () => {
  const s = { source_id: 'r1', indexable: true, fp: 'fp1', payload: { row: F.weeklyLegacy(), brand: F.CTX.brand } };
  const calls: Array<[string, any]> = [];
  const rpc = async (fn: string, args: any = {}) => {
    calls.push([fn, args]);
    if (fn === 'ai_source_types') return ['report'];
    if (fn === 'ai_ingest_source') return args.p_ids.map((id: string) => ({ ...s, source_id: id }));
    if (fn === 'ai_ingest_existing') return [];
    if (fn === 'ai_ingest_defer') return true;
    if (fn === 'ai_ingest_fail') return true;
    if (fn === 'ai_ingest_claim') return calls.filter(([f]) => f === 'ai_ingest_claim').length === 1
      ? [{ id: 1, source_type: 'report', source_id: 'r1', op: 'upsert', attempts: 1 }, { id: 2, source_type: 'report', source_id: 'r2', op: 'upsert', attempts: 1 }] : [];
    if (fn === 'ai_pipeline_version' || fn === 'ai_embed_model') return fn === 'ai_pipeline_version' ? PIPELINE_VERSION : DEFAULT_CONFIG.EMBED_MODEL;
    return null;
  };
  const embed = async () => { throw new EmbedError(`embeddings HTTP 429: ${NO_CREDITS_BODY}`, false, 429); };
  const stats = await runWorker({ rpc, embed, recordRun: false, checkPipeline: false, workerId: 'w' });
  const defers = calls.filter(([f]) => f === 'ai_ingest_defer');
  assert.equal(defers.length, 2);
  assert.equal(defers[0][1].p_delay_seconds, PROVIDER_DEFER_SECONDS);
  assert.equal(calls.filter(([f]) => f === 'ai_ingest_fail').length, 0);
  assert.deepEqual([stats.deferred, stats.failed, stats.provider_issue], [2, 0, 'quota']);
  assert.equal(calls.filter(([f]) => f === 'ai_ingest_claim').length, 1, 'stopped after the batch');
  // an ordinary embedding error still counts as a failure
  const s2 = emptyStats();
  await processBatch([{ id: 3, source_type: 'report', source_id: 'r3', op: 'upsert', attempts: 1 }],
    { rpc, workerId: 'w', pipelineVersion: PIPELINE_VERSION, model: DEFAULT_CONFIG.EMBED_MODEL, embed: async () => { throw new Error('socket hang up'); } }, s2);
  assert.deepEqual([s2.failed, s2.deferred, s2.provider_issue], [1, 0, null]);
});
