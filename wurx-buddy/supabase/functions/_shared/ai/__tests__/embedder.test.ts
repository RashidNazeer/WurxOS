import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EmbedError, embedTexts, makeBatches } from '../embedder.ts';

const DIMS = 4;
const vec = (i: number) => [i, 0, 0, 1];

// Fake OpenAI: embeds each input as vec(<number in the text>), in shuffled
// order (the API returns an index per item; we must honour it).
function fakeApi(opts: { failures?: number[]; delayMs?: number; retryAfter?: string } = {}) {
  const calls: { inputs: string[]; auth: string | null }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const failures = [...(opts.failures ?? [])];
  const impl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ inputs: body.input, auth: new Headers(init.headers).get('authorization') });
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      const status = failures.shift();
      if (status) {
        const headers = opts.retryAfter ? { 'retry-after': opts.retryAfter } : undefined;
        return new Response(JSON.stringify({ error: { message: 'nope' } }), { status, headers });
      }
      const data = body.input.map((t: string, index: number) => ({ index, embedding: vec(Number(/\d+/.exec(t)![0])) })).reverse();
      return new Response(JSON.stringify({ data, usage: { prompt_tokens: body.input.length * 3, total_tokens: body.input.length * 3 } }));
    } finally {
      inFlight--;
    }
  }) as typeof fetch;
  return { impl, calls, maxInFlight: () => maxInFlight };
}

const texts = (n: number) => Array.from({ length: n }, (_, i) => `text ${i}`);
const noSleep = { sleep: async () => {}, random: () => 0 };

test('makeBatches cuts by input count and by token budget', () => {
  assert.deepEqual(makeBatches(texts(5), 2, 1000), [[0, 1], [2, 3], [4]]);
  assert.deepEqual(makeBatches(['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)], 96, 20), [[0, 1], [2]]);
  assert.deepEqual(makeBatches(['x'.repeat(400)], 96, 20), [[0]], 'an oversized single input still gets its own batch');
});

test('embeds in order, batches, concurrency ≤ 2, sums usage, sends the key', async () => {
  const api = fakeApi({ delayMs: 5 });
  const r = await embedTexts(texts(10), { apiKey: 'sk-test', dims: DIMS, batchInputs: 2, fetchImpl: api.impl, ...noSleep });
  assert.deepEqual(r.vectors, texts(10).map((_, i) => vec(i)));
  assert.equal(r.batches, 5);
  assert.equal(r.requests, 5);
  assert.equal(r.usage.promptTokens, 30);
  assert.ok(api.maxInFlight() <= 2 && api.maxInFlight() >= 2, `max in flight ${api.maxInFlight()}`);
  assert.equal(api.calls[0].auth, 'Bearer sk-test');
});

test('429 / 5xx are retried with exponential backoff, then succeed', async () => {
  const api = fakeApi({ failures: [429, 503] });
  const waits: number[] = [];
  const r = await embedTexts(texts(1), { apiKey: 'k', dims: DIMS, fetchImpl: api.impl, sleep: async (ms) => { waits.push(ms); }, random: () => 0 });
  assert.equal(r.requests, 3);
  assert.deepEqual(waits, [1000, 2000]);
  assert.deepEqual(r.vectors, [vec(0)]);
});

test('Retry-After is honoured when longer than the backoff', async () => {
  const api = fakeApi({ failures: [429], retryAfter: '7' });
  const waits: number[] = [];
  await embedTexts(texts(1), { apiKey: 'k', dims: DIMS, fetchImpl: api.impl, sleep: async (ms) => { waits.push(ms); }, random: () => 0 });
  assert.deepEqual(waits, [7000]);
});

test('gives up after max retries (1 + 4 attempts) with a retryable EmbedError', async () => {
  const api = fakeApi({ failures: [500, 500, 500, 500, 500, 500] });
  await assert.rejects(embedTexts(texts(1), { apiKey: 'k', dims: DIMS, fetchImpl: api.impl, ...noSleep }),
    (e: unknown) => e instanceof EmbedError && e.status === 500 && e.retryable);
  assert.equal(api.calls.length, 5);
});

test('4xx other than 429 fails at once, and the key never appears in the error', async () => {
  const api = fakeApi({ failures: [400] });
  await assert.rejects(embedTexts(texts(1), { apiKey: 'sk-secret', dims: DIMS, fetchImpl: api.impl, ...noSleep }),
    (e: unknown) => e instanceof EmbedError && e.status === 400 && !e.retryable && !e.message.includes('sk-secret'));
  assert.equal(api.calls.length, 1);
});

test('timeout aborts the request and is retried', async () => {
  let n = 0;
  const hang = (async (_u: string, init: RequestInit) => {
    n++;
    if (n === 1) {
      return await new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted'))));
    }
    return new Response(JSON.stringify({ data: [{ index: 0, embedding: vec(0) }], usage: { prompt_tokens: 1, total_tokens: 1 } }));
  }) as typeof fetch;
  const r = await embedTexts(texts(1), { apiKey: 'k', dims: DIMS, timeoutMs: 20, fetchImpl: hang, ...noSleep });
  assert.equal(r.requests, 2);
});

test('rejects empty input, missing key, and wrong dimensions', async () => {
  await assert.rejects(embedTexts(['ok', ' '], { apiKey: 'k', fetchImpl: fakeApi().impl }), /input 1 is empty/);
  await assert.rejects(embedTexts(['x'], { apiKey: '' }), /apiKey is required/);
  await assert.rejects(embedTexts(texts(1), { apiKey: 'k', dims: 1536, fetchImpl: fakeApi().impl, ...noSleep }), /expected 1536 dims/);
});
