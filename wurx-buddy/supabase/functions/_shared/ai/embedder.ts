// Batched OpenAI embeddings (A§7). The API key is always passed in by the
// caller; nothing here reads the environment.
//
// Batches are cut by input count AND estimated tokens, sent at most
// `concurrency` at a time, and retried on 429 / 5xx / network errors /
// timeouts with exponential backoff 1s, 2s, 4s, 8s (+ jitter, or Retry-After
// when the API sends one). Any other status fails immediately.

import { DEFAULT_CONFIG } from './config.ts';
import { estimateTokens } from './text.ts';
import { providerAccountIssue, retryAfterMs } from './providerErrors.ts';

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
  dimensions?: number;          // sent as `dimensions` (NVIDIA: 1536)
  normalize?: boolean;          // L2-normalise each vector
  extraBody?: Record<string, unknown>;   // provider fields (NVIDIA: input_type, encoding_format)
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
// Free tiers put the wait in the body ("retry in 37s"): honour it.
const BODY_RETRY_CAP_MS = 65_000;

export function l2normalize(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  return n > 0 ? v.map((x) => x / n) : v;
}

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
          body: JSON.stringify({ model, input, ...(opts.dimensions ? { dimensions: opts.dimensions } : {}), ...(opts.extraBody ?? {}) }),
          signal: ctrl.signal,
        });
      } catch (e) {
        const timedOut = ctrl.signal.aborted;
        throw new EmbedError(timedOut ? `embeddings request timed out after ${timeoutMs} ms` : `embeddings network error: ${(e as Error)?.message ?? e}`, true);
      }
      if (!res.ok) {
        const body = (await res.text().catch(() => '')).slice(0, 300);
        // No credits / a refused key / a wait of hours is not a passing rate limit: retrying cannot help.
        const noCredit = !!providerAccountIssue({ status: res.status, message: body });
        const err = new EmbedError(`embeddings HTTP ${res.status}: ${body}`, !noCredit && (res.status === 429 || res.status >= 500), res.status);
        const ra = Number(res.headers.get('retry-after'));
        if (Number.isFinite(ra) && ra > 0) err.retryAfterMs = Math.min(ra * 1000, RETRY_AFTER_CAP_MS);
        else if (err.retryable) {
          const inBody = retryAfterMs(body);
          if (inBody != null) err.retryAfterMs = Math.min(inBody, BODY_RETRY_CAP_MS);
        }
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
          vectors[idx[d.index]] = opts.normalize ? l2normalize(d.embedding) : d.embedding;
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

// ── the second vector space (mig 406) ────────────────────────────────────────
// NVIDIA llama-nemotron-embed-vl-1b-v2 (OpenAI-compatible endpoint), asked for
// 1536 dims. Its vectors live ONLY in ai_chunks.embedding_alt, labelled
// ALT_EMBED_MODEL: a different model's space, never compared with OpenAI's.
// An asymmetric model: documents are embedded as 'passage', questions as 'query'.
// Free (dev/test) keys: one request at a time, small batches.
export const ALT_EMBED_MODEL = 'nvidia:llama-nemotron-embed-vl-1b-v2';   // the label stored in embed_model_alt
export const NVIDIA_EMBED_MODEL = 'nvidia/llama-nemotron-embed-vl-1b-v2';
export const NVIDIA_EMBED_ENDPOINT = 'https://integrate.api.nvidia.com/v1/embeddings';

export function nvidiaEmbedOptions(kind: 'passage' | 'query', extra: Partial<EmbedOptions> = {}): Partial<EmbedOptions> {
  return {
    model: NVIDIA_EMBED_MODEL, endpoint: NVIDIA_EMBED_ENDPOINT, dims: 1536, dimensions: 1536,
    extraBody: { input_type: kind, encoding_format: 'float' },
    batchInputs: 32, batchTokens: 16_000, concurrency: 1, ...extra,
  };
}

// Keys in order (OpenAI: primary then fallback; NVIDIA: nvidia then nvidia2):
// the next key is tried only on an account problem (no credits, key refused,
// a wait of hours). Throws the last error when every key refused.
export async function embedWithKeys(texts: string[], keys: Array<string | null | undefined>, extra: Partial<EmbedOptions> = {}):
  Promise<EmbedResult & { keyIndex: number }> {
  const usable = keys.filter((k): k is string => !!k);
  if (!usable.length) throw new EmbedError('no API key configured', false);
  let last: unknown = null;
  for (let i = 0; i < usable.length; i++) {
    try { return { ...(await embedTexts(texts, { ...extra, apiKey: usable[i] })), keyIndex: i }; }
    catch (e) { last = e; if (!providerAccountIssue(e)) throw e; }
  }
  throw last;
}

// ── query vectors for ai_search ──────────────────────────────────────────────
// CONTRACT (ai_search mig 406; wired in agent/server.ts → searchIndex):
//   const qv = await queryVectors(question, { openai, openaiFallback, nvidia, nvidia2 }, { alt: 'fallback' });
//   rpc('ai_search', { p_query_embedding: qv.primary && vec(qv.primary),
//                      p_query_embedding_alt: qv.alt && vec(qv.alt), ... })
//   • primary: OpenAI (primary key, then the fallback key) → the `embedding` space.
//   • alt:     NVIDIA (input_type 'query') → the `embedding_alt` space.
//              alt:'fallback' (default) asks for it only when no OpenAI key could
//              embed; 'always' also when one could (chunks written during an
//              OpenAI outage have only an alt vector until the backfill runs);
//              'never' skips it.
//   • Both null → keyword-only search (ai_search still answers).
//   • Never throws for a provider problem: issues[] says who failed and why
//     (ProviderIssue from providerErrors.ts, or 'error'), for logs and notes.
//   • Tests inject fetchImpl; nothing here reads the environment.
export type QueryVectors = {
  primary: number[] | null;
  alt: number[] | null;
  issues: Array<{ provider: 'openai' | 'nvidia'; issue: string; message: string }>;
};

export async function queryVectors(text: string,
  keys: { openai?: string | null; openaiFallback?: string | null; nvidia?: string | null; nvidia2?: string | null },
  o: { alt?: 'fallback' | 'always' | 'never'; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; timeoutMs?: number } = {}): Promise<QueryVectors> {
  const out: QueryVectors = { primary: null, alt: null, issues: [] };
  const q = String(text ?? '').trim();
  if (!q) return out;
  const common = { fetchImpl: o.fetchImpl, sleep: o.sleep, maxRetries: 1, timeoutMs: o.timeoutMs ?? 8000 };
  const note = (provider: 'openai' | 'nvidia', e: unknown) =>
    out.issues.push({ provider, issue: providerAccountIssue(e) ?? 'error', message: String((e as Error)?.message ?? e).slice(0, 200) });
  if (keys.openai || keys.openaiFallback) {
    try { out.primary = (await embedWithKeys([q], [keys.openai, keys.openaiFallback], common)).vectors[0]; }
    catch (e) { note('openai', e); }
  }
  const wantAlt = o.alt === 'always' || ((o.alt ?? 'fallback') === 'fallback' && !out.primary);
  if (wantAlt && (keys.nvidia || keys.nvidia2)) {
    try { out.alt = (await embedWithKeys([q], [keys.nvidia, keys.nvidia2], nvidiaEmbedOptions('query', common))).vectors[0]; }
    catch (e) { note('nvidia', e); }
  }
  return out;
}
