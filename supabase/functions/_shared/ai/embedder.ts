// Batched embeddings over FREE providers only (NVIDIA, Gemini). OpenAI is gone:
// the paid key has no credits and the free-tier key cannot embed (HTTP 429
// "no credits remaining", 2026-11-02). embedTexts refuses OpenAI's host, so no
// code path can send an embedding request that could be billed.
// The API key is always passed in by the caller; nothing here reads the environment.
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
  format?: 'openai' | 'gemini';          // request shape: OpenAI-style /embeddings (NVIDIA) or Gemini batchEmbedContents
  taskType?: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';   // Gemini only
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

// ── providers ────────────────────────────────────────────────────────────────
// Two vector spaces, one model each, never compared with each other:
//   ai_chunks.embedding      (the MAIN space)      always DEFAULT_CONFIG.EMBED_MODEL's provider
//   ai_chunks.embedding_alt  (the SECOND space)    ai_assistant_config.embed_alt_provider
// Both are 1536 dims.
//   nvidia  llama-nemotron-embed-vl-1b-v2: asymmetric (documents 'passage', questions 'query')
//   gemini  gemini-embedding-001 (native batchEmbedContents with RETRIEVAL_DOCUMENT /
//           RETRIEVAL_QUERY task types), 1536 of its 3072 dims, so L2-normalised here
export type EmbedProvider = 'nvidia' | 'gemini';
export type AltProvider = EmbedProvider;   // back-compat name

export const NVIDIA_EMBED_MODEL = 'nvidia/llama-nemotron-embed-vl-1b-v2';
export const NVIDIA_EMBED_ENDPOINT = 'https://integrate.api.nvidia.com/v1/embeddings';
export const GEMINI_EMBED_MODEL = 'gemini-embedding-001';
export const GEMINI_EMBED_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// The label stored in embedding_model / embed_model_alt; ai_alt_model_for() in SQL must agree.
export const MODEL_LABEL: Record<EmbedProvider, string> = {
  nvidia: 'nvidia:llama-nemotron-embed-vl-1b-v2',
  gemini: `gemini:${GEMINI_EMBED_MODEL}`,
};
export const ALT_MODEL_LABEL = MODEL_LABEL;   // back-compat name
export const ALT_EMBED_MODEL = MODEL_LABEL.nvidia;
export const isAltProvider = (p: unknown): p is EmbedProvider => p === 'nvidia' || p === 'gemini';
export const providerOfLabel = (label: string): EmbedProvider | null => {
  const p = String(label ?? '').split(':')[0];
  return isAltProvider(p) ? p : null;
};
// The provider of the MAIN space is fixed by the model label the pipeline is built for.
export const MAIN_PROVIDER: EmbedProvider = providerOfLabel(DEFAULT_CONFIG.EMBED_MODEL) ?? 'nvidia';

export type AltKeys = { nvidia?: string | null; nvidia2?: string | null; gemini?: string | null };
export type EmbedKeys = AltKeys;

// Every key of a provider, in order (NVIDIA has two).
export const keysFor = (provider: EmbedProvider, keys: AltKeys): Array<string | null | undefined> =>
  (provider === 'gemini' ? [keys.gemini] : [keys.nvidia, keys.nvidia2]);
export const altKeysFor = keysFor;   // back-compat name

export function embedOptions(provider: EmbedProvider, kind: 'passage' | 'query', extra: Partial<EmbedOptions> = {}): Partial<EmbedOptions> {
  if (provider === 'gemini') {
    return {
      model: GEMINI_EMBED_MODEL, endpoint: GEMINI_EMBED_BASE, format: 'gemini', dims: 1536, dimensions: 1536, normalize: true,
      taskType: kind === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT',
      // The free tier allows about 100 inputs and ~30k tokens a minute: small requests, paced by the worker.
      batchInputs: 50, batchTokens: 20_000, concurrency: 1, maxRetries: 1, ...extra,
    };
  }
  return {
    model: NVIDIA_EMBED_MODEL, endpoint: NVIDIA_EMBED_ENDPOINT, format: 'openai', dims: 1536, dimensions: 1536,
    extraBody: { input_type: kind, encoding_format: 'float' },
    // Measured 2026-11-02: 128 passages (49k tokens) answer in 3 s; 70 rapid requests drew no 429.
    batchInputs: 96, batchTokens: 40_000, concurrency: 1, maxRetries: 2, ...extra,
  };
}
export const altEmbedOptions = embedOptions;   // back-compat name
export const nvidiaEmbedOptions = (kind: 'passage' | 'query', extra: Partial<EmbedOptions> = {}) => embedOptions('nvidia', kind, extra);
export const geminiEmbedOptions = (extra: Partial<EmbedOptions> = {}) => embedOptions('gemini', 'passage', extra);

export async function embedTexts(texts: string[], opts: EmbedOptions): Promise<EmbedResult> {
  if (!opts.apiKey) throw new EmbedError('embedTexts: apiKey is required', false);
  const empty = texts.findIndex((t) => typeof t !== 'string' || !t.trim());
  if (empty >= 0) throw new EmbedError(`embedTexts: input ${empty} is empty`, false);

  const model = opts.model ?? NVIDIA_EMBED_MODEL;
  const dims = opts.dims ?? DEFAULT_CONFIG.EMBED_DIMS;
  const maxRetries = opts.maxRetries ?? DEFAULT_CONFIG.EMBED_MAX_RETRIES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CONFIG.EMBED_TIMEOUT_MS;
  const endpoint = opts.endpoint ?? NVIDIA_EMBED_ENDPOINT;
  const format = opts.format ?? 'openai';
  if (/(^|\.)openai\.com$/i.test(new URL(endpoint).hostname)) {
    throw new EmbedError('embedTexts: OpenAI embeddings are not used any more (free providers only)', false);
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;

  const batches = makeBatches(texts,
    opts.batchInputs ?? DEFAULT_CONFIG.EMBED_BATCH_INPUTS,
    opts.batchTokens ?? DEFAULT_CONFIG.EMBED_BATCH_TOKENS);
  const vectors: number[][] = new Array(texts.length);
  const usage = { promptTokens: 0, totalTokens: 0 };
  let requests = 0;

  type Raw = { vectors: Array<{ index: number; embedding: number[] }>; tokens: number };
  async function once(input: string[]): Promise<Raw> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    requests++;
    try {
      let res: Response;
      try {
        res = format === 'gemini'
          ? await doFetch(`${endpoint.replace(/\/$/, '')}/models/${model}:batchEmbedContents`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-goog-api-key': opts.apiKey },
              body: JSON.stringify({ requests: input.map((t) => ({
                model: `models/${model}`, content: { parts: [{ text: t }] },
                taskType: opts.taskType ?? 'RETRIEVAL_DOCUMENT',
                ...(opts.dimensions ? { outputDimensionality: opts.dimensions } : {}) })) }),
              signal: ctrl.signal,
            })
          : await doFetch(endpoint, {
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
        const body = (await res.text().catch(() => '')).slice(0, 1500);
        // No quota / a refused key / a wait of hours is not a passing rate limit: retrying cannot help.
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
      const json = await res.json();
      if (format === 'gemini') {
        const list = Array.isArray(json?.embeddings) ? json.embeddings : [];
        return { vectors: list.map((d: { values: number[] }, index: number) => ({ index, embedding: d.values })),
                 tokens: input.reduce((a, t) => a + estimateTokens(t), 0) };
      }
      return { vectors: Array.isArray(json?.data) ? json.data : [], tokens: Number(json?.usage?.total_tokens ?? 0) };
    } finally {
      clearTimeout(timer);
    }
  }

  async function runBatch(idx: number[]) {
    const input = idx.map((i) => texts[i]);
    for (let attempt = 0; ; attempt++) {
      try {
        const raw = await once(input);
        if (raw.vectors.length !== input.length) {
          throw new EmbedError(`embeddings: expected ${input.length} vectors, got ${raw.vectors.length}`, false);
        }
        for (const d of raw.vectors) {
          if (!Array.isArray(d.embedding) || d.embedding.length !== dims) {
            throw new EmbedError(`embeddings: expected ${dims} dims, got ${d.embedding?.length}`, false);
          }
          vectors[idx[d.index]] = opts.normalize ? l2normalize(d.embedding) : d.embedding;
        }
        usage.promptTokens += raw.tokens;
        usage.totalTokens += raw.tokens;
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

// Keys in order (NVIDIA: nvidia then nvidia2): the next key is tried only on an
// account problem (no quota, key refused, a wait of hours). Throws the last
// error when every key refused.
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

// A query vector remembers which model made it, so ai_search can refuse to compare it with
// chunks from another model (WeakMap: the array itself stays a plain number[]).
const VECTOR_MODEL = new WeakMap<object, string>();
export function tagVector<T extends number[]>(v: T, model: string): T { VECTOR_MODEL.set(v, model); return v; }
export const vectorModel = (v: number[] | null | undefined): string | null => (v ? VECTOR_MODEL.get(v) ?? null : null);

// ── query vectors ────────────────────────────────────────────────────────────
// A question is embedded in EVERY space that holds document vectors, each by the
// provider that filled it (never one provider's query against another's
// documents): ai_search takes p_query_embedding (main space) and
// p_query_embedding_alt (second space) and fuses them with the keywords.
//   queryVectors(question, keys, { altProvider }) → { main, alt, issues }
//   • main: MAIN_PROVIDER's key(s); alt: ai_assistant_config.embed_alt_provider's.
//   • Either may be null (no key, provider down); both null → keyword-only search.
//   • Never throws for a provider problem: issues[] says who failed and why.
//   • Tests inject fetchImpl; nothing here reads the environment.
export type QueryVectors = {
  main: number[] | null;
  alt: number[] | null;
  issues: Array<{ provider: EmbedProvider; issue: string; message: string }>;
};

export async function queryVectors(text: string, keys: AltKeys,
  o: { altProvider?: EmbedProvider | null; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; timeoutMs?: number } = {}): Promise<QueryVectors> {
  const out: QueryVectors = { main: null, alt: null, issues: [] };
  const q = String(text ?? '').trim();
  if (!q) return out;
  const common = { fetchImpl: o.fetchImpl, sleep: o.sleep, maxRetries: 1, timeoutMs: o.timeoutMs ?? 8000 };
  const one = async (provider: EmbedProvider): Promise<number[] | null> => {
    const list = keysFor(provider, keys);
    if (!list.some(Boolean)) return null;
    try { return (await embedWithKeys([q], list, embedOptions(provider, 'query', common))).vectors[0]; }
    catch (e) {
      out.issues.push({ provider, issue: providerAccountIssue(e) ?? 'error', message: String((e as Error)?.message ?? e).slice(0, 200) });
      return null;
    }
  };
  const altProvider = o.altProvider && o.altProvider !== MAIN_PROVIDER ? o.altProvider : null;
  const [m, a] = await Promise.all([one(MAIN_PROVIDER), altProvider ? one(altProvider) : Promise.resolve(null)]);
  out.main = m;
  out.alt = a;
  return out;
}
