// Batched OpenAI embeddings (A§7). The API key is always passed in by the
// caller; nothing here reads the environment.
//
// Batches are cut by input count AND estimated tokens, sent at most
// `concurrency` at a time, and retried on 429 / 5xx / network errors /
// timeouts with exponential backoff 1s, 2s, 4s, 8s (+ jitter, or Retry-After
// when the API sends one). Any other status fails immediately.

import { DEFAULT_CONFIG } from './config.ts';
import { estimateTokens } from './text.ts';

export type EmbedOptions = {
  apiKey: string;
  model?: string;
  dims?: number;
  batchInputs?: number;
  batchTokens?: number;
  concurrency?: number;
  maxRetries?: number;
  timeoutMs?: number;
  endpoint?: string;
  // Test seams.
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

export type EmbedResult = {
  vectors: number[][];          // same order as the input
  usage: { promptTokens: number; totalTokens: number };
  requests: number;             // HTTP calls made, retries included
  batches: number;
};

export class EmbedError extends Error {
  status?: number;
  retryable: boolean;
  retryAfterMs?: number;
  constructor(message: string, retryable: boolean, status?: number) {
    super(message);
    this.name = 'EmbedError';
    this.retryable = retryable;
    this.status = status;
  }
}

const RETRY_AFTER_CAP_MS = 30_000;

export function makeBatches(texts: string[], maxInputs: number, maxTokens: number): number[][] {
  const batches: number[][] = [];
  let cur: number[] = [];
  let curTok = 0;
  texts.forEach((t, i) => {
    const n = estimateTokens(t);
    if (cur.length && (cur.length >= maxInputs || curTok + n > maxTokens)) {
      batches.push(cur);
      cur = [];
      curTok = 0;
    }
    cur.push(i);
    curTok += n;
  });
  if (cur.length) batches.push(cur);
  return batches;
}

export async function embedTexts(texts: string[], opts: EmbedOptions): Promise<EmbedResult> {
  if (!opts.apiKey) throw new EmbedError('embedTexts: apiKey is required', false);
  const empty = texts.findIndex((t) => typeof t !== 'string' || !t.trim());
  if (empty >= 0) throw new EmbedError(`embedTexts: input ${empty} is empty`, false);

  const model = opts.model ?? DEFAULT_CONFIG.EMBED_MODEL;
  const dims = opts.dims ?? DEFAULT_CONFIG.EMBED_DIMS;
  const maxRetries = opts.maxRetries ?? DEFAULT_CONFIG.EMBED_MAX_RETRIES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CONFIG.EMBED_TIMEOUT_MS;
  const endpoint = opts.endpoint ?? 'https://api.openai.com/v1/embeddings';
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;

  const batches = makeBatches(texts,
    opts.batchInputs ?? DEFAULT_CONFIG.EMBED_BATCH_INPUTS,
    opts.batchTokens ?? DEFAULT_CONFIG.EMBED_BATCH_TOKENS);
  const vectors: number[][] = new Array(texts.length);
  const usage = { promptTokens: 0, totalTokens: 0 };
  let requests = 0;

  async function once(input: string[]): Promise<{ data: { index: number; embedding: number[] }[]; usage?: { prompt_tokens?: number; total_tokens?: number } }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    requests++;
    try {
      let res: Response;
      try {
        res = await doFetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}` },
          body: JSON.stringify({ model, input }),
          signal: ctrl.signal,
        });
      } catch (e) {
        const timedOut = ctrl.signal.aborted;
        throw new EmbedError(timedOut ? `embeddings request timed out after ${timeoutMs} ms` : `embeddings network error: ${(e as Error)?.message ?? e}`, true);
      }
      if (!res.ok) {
        const body = (await res.text().catch(() => '')).slice(0, 300);
        const err = new EmbedError(`embeddings HTTP ${res.status}: ${body}`, res.status === 429 || res.status >= 500, res.status);
        const ra = Number(res.headers.get('retry-after'));
        if (Number.isFinite(ra) && ra > 0) err.retryAfterMs = Math.min(ra * 1000, RETRY_AFTER_CAP_MS);
        throw err;
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function runBatch(idx: number[]) {
    const input = idx.map((i) => texts[i]);
    for (let attempt = 0; ; attempt++) {
      try {
        const json = await once(input);
        if (!Array.isArray(json?.data) || json.data.length !== input.length) {
          throw new EmbedError(`embeddings: expected ${input.length} vectors, got ${json?.data?.length ?? 0}`, false);
        }
        for (const d of json.data) {
          if (!Array.isArray(d.embedding) || d.embedding.length !== dims) {
            throw new EmbedError(`embeddings: expected ${dims} dims, got ${d.embedding?.length}`, false);
          }
          vectors[idx[d.index]] = d.embedding;
        }
        usage.promptTokens += json.usage?.prompt_tokens ?? 0;
        usage.totalTokens += json.usage?.total_tokens ?? 0;
        return;
      } catch (e) {
        const err = e instanceof EmbedError ? e : new EmbedError(String((e as Error)?.message ?? e), false);
        if (!err.retryable || attempt >= maxRetries) throw err;
        const backoff = 1000 * 2 ** attempt;
        await sleep(Math.max(err.retryAfterMs ?? 0, backoff + Math.floor(random() * backoff * 0.25)));
      }
    }
  }

  // Simple worker pool: `concurrency` loops pulling the next batch.
  let next = 0;
  const workers = Array.from({ length: Math.min(opts.concurrency ?? DEFAULT_CONFIG.EMBED_CONCURRENCY, batches.length) }, async () => {
    while (next < batches.length) await runBatch(batches[next++]);
  });
  await Promise.all(workers);
  return { vectors, usage, requests, batches: batches.length };
}
