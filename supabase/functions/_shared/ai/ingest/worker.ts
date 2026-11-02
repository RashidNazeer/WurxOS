// The ingest worker (A§9.5), runtime-neutral: the ai-ingest edge function
// (Deno) and scripts/ingest.mjs (Node) both call runWorker with their own Rpc
// and their free-provider API keys.
//
//   claim ≤ CLAIM_BATCH → plan every item from its LIVE row (the queued op is
//   only a hint: a queued delete for a re-submitted report still upserts) →
//   one embedding pass for the whole batch, deduplicated by content_hash →
//   write/delete/touch per document, each RPC checking this worker still holds
//   the queue row and completing it in the same transaction → repeat until the
//   queue is empty or WORKER_TIME_BUDGET is spent. One ai_ingest_runs row per run.
//
// A false / {ok:false} from the database means another worker reclaimed the
// item (we were too slow): the result is dropped, the other worker redoes it.
//
// A batch that overruns the budget is not cut short: its items stay
// 'processing' only if the function itself is killed, and are reclaimed after
// the 10-minute lock timeout (counted as an attempt).
//
// Vectors (mig 432). Two spaces, both on FREE providers (OpenAI is gone):
//   main  ai_chunks.embedding      NVIDIA llama-nemotron-embed-vl-1b-v2  (the one searches rely on)
//   alt   ai_chunks.embedding_alt  ai_assistant_config.embed_alt_provider (Gemini): the safety net
// New chunks are written with whatever vectors could be made; a chunk with none is
// 'pending' (keyword-searchable at once). A source type is sent to a provider only
// if that PROVIDER's allow-list names it (incentive/pay data: never). After the
// queue, backfillVectors() fills missing vectors in each space until the time budget
// ends. A space that fails is DEFERRED (ai_vector_defer: quota/auth 30 min, a rate
// limit or transient error 2 min) and cleared again by its next success
// (ai_vector_ok), so it can never stay 'down' for good.

import { DEFAULT_CONFIG, PIPELINE_VERSION } from '../config.ts';
import { embedOptions, embedWithKeys, isAltProvider, keysFor, MAIN_PROVIDER, MODEL_LABEL, type AltKeys, type EmbedProvider } from '../embedder.ts';
import { providerAccountIssue, retryAfterMs, type ProviderIssue } from '../providerErrors.ts';
import { estimateTokens } from '../text.ts';
import { SOURCE_TYPES } from '../extractors/index.ts';
import type { SourceType } from '../extractors/index.ts';
import type { ExistingDoc, QueueItem, Rpc, SourceRecord } from './db.ts';
import { planDocument } from './plan.ts';
import type { CustomSource, Plan, PlanOptions } from './plan.ts';

// A quota / refused-key / hours-long limit defers the space this long (items keep all 5 attempts).
export const PROVIDER_DEFER_SECONDS = 1800;
// A passing rate limit (429 with a wait of seconds) or a transient error (5xx, network, timeout).
export const TRANSIENT_DEFER_SECONDS = 120;
// A provider with no API key configured: look again in an hour (the secret may have been added).
export const NO_KEY_DEFER_SECONDS = 3600;

export const isSourceType = (t: string): t is SourceType => (SOURCE_TYPES as string[]).includes(t);

export type Space = 'main' | 'alt';

// requests = HTTP calls made (retries included), for ai_ingest_runs.stats.embed_requests.
// waitMs: how long a free tier's per-minute allowance makes the NEXT call wait (0 = none).
export type Embedder = ((texts: string[]) => Promise<{ vectors: number[][]; tokens: number; requests?: number }>) & { waitMs?: () => number };

// What a provider's free tier lets one key do. Measured 2026-11-02 on our own data:
// NVIDIA answered 70 requests in 26 s and 128 passages (49k tokens) in 3 s with no 429;
// Gemini free is ~100 inputs and ~30k tokens a MINUTE (a batch of 100 straight after 1 got a 429).
export const PACE: Record<EmbedProvider, { gapMs: number; inputsPerMin: number; tokensPerMin: number }> = {
  nvidia: { gapMs: 1200, inputsPerMin: 6000, tokensPerMin: 2_400_000 },
  gemini: { gapMs: 0, inputsPerMin: 80, tokensPerMin: 24_000 },
};

export function paceMs(provider: EmbedProvider, inputs: number, tokens: number): number {
  const p = PACE[provider];
  return Math.max(p.gapMs, Math.ceil((inputs / p.inputsPerMin) * 60_000), Math.ceil((tokens / p.tokensPerMin) * 60_000));
}

// An embedder for one provider's documents ('passage' / RETRIEVAL_DOCUMENT) over
// that provider's keys (NVIDIA has two: the second is tried on an account problem).
// undefined when the provider has no key. It paces itself to the free tier.
export function providerEmbedder(provider: EmbedProvider, keys: AltKeys, o: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => number } = {}): Embedder | undefined {
  const list = keysFor(provider, keys);
  if (!list.some(Boolean)) return undefined;
  const now = o.now ?? (() => Date.now());
  let nextAt = 0;
  const fn: Embedder = async (texts) => {
    const r = await embedWithKeys(texts, list, embedOptions(provider, 'passage', { fetchImpl: o.fetchImpl, sleep: o.sleep }));
    nextAt = now() + paceMs(provider, texts.length, texts.reduce((a, t) => a + estimateTokens(t), 0));
    return { vectors: r.vectors, tokens: r.usage.totalTokens, requests: r.requests };
  };
  fn.waitMs = () => Math.max(0, nextAt - now());
  return fn;
}
export const altEmbedder = (provider: EmbedProvider, keys: AltKeys, fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void>): Embedder | undefined =>
  providerEmbedder(provider, keys, { fetchImpl, sleep });
export const nvidiaEmbedder = (keys: Array<string | null | undefined>, fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void>): Embedder =>
  providerEmbedder('nvidia', { nvidia: keys[0], nvidia2: keys[1] }, { fetchImpl, sleep })!;

// What ai_embed_settings() says. main_sources / alt_sources are the document types
// each space's PROVIDER may see (privacy, set by the Boss); alt_provider is null
// when the second space is switched off.
export type EmbedSettings = {
  main_provider: EmbedProvider; main_model: string; main_sources: string[];
  alt_provider: EmbedProvider | null; alt_model: string; alt_sources: string[]; alt_always: boolean;
};

// Per run. `deferred`: the database says wait (ai_vector_ready); `failed`: this run
// already got an error from that space, so it is not asked again until the next run.
// A space is usable only if it has an embedder, is not deferred and has not failed:
// computed when needed, never stored, so the order in which things are built cannot matter.
type EmbedState = { settings: EmbedSettings; deferred: Record<Space, boolean>; failed: Record<Space, boolean>; recovered: Record<Space, boolean> };

// Per run: batches until the time budget ends. The `none` bucket (no vector at all) is served first by SQL.
export const BACKFILL = { batch: { main: 96, alt: 40 } as Record<Space, number>, maxBatches: 400 };

export type RunStats = {
  claimed: number;
  succeeded: number;
  failed: number;
  skipped_unchanged: number;
  touched: number;
  written: number;
  deleted: number;
  noop: number;
  disabled: number;         // items of a source switched off: completed, no work
  lost_lock: number;
  soft_deleted: number;
  embedded_chunks: number;  // chunks given a MAIN vector while ingesting
  embed_tokens: number;
  embed_calls: number;      // embedder invocations (one per batch that had new text)
  embed_requests: number;   // HTTP requests to the embeddings APIs
  reused_chunks: number;
  by_type: Record<string, number>;
  errors: string[];
  deferred: number;                     // put back, attempt not spent: an account problem outside embedding
  provider_issue: ProviderIssue | null; // main space: 'quota' | 'auth' | 'limit'
  alt_issue: ProviderIssue | null;      // the same for the second space
  vector_pending: number;               // chunks written with no vector in either space
  alt_embedded: number;                 // chunks given a second-space vector while ingesting
  backfilled_primary: number;           // missing MAIN vectors filled by the backfill (name kept for ai_ingest_runs readers)
  backfilled_alt: number;               // missing second-space vectors filled by the backfill
  spaces_down: Space[];                 // spaces left deferred by this run, with the reason in errors
  skipped_rows: number;                 // chunks a provider refused one by one (retried next run)
};

export const emptyStats = (): RunStats => ({
  claimed: 0, succeeded: 0, failed: 0, skipped_unchanged: 0, touched: 0, written: 0, deleted: 0, soft_deleted: 0,
  noop: 0, disabled: 0, lost_lock: 0, embedded_chunks: 0, embed_tokens: 0, embed_calls: 0, embed_requests: 0, reused_chunks: 0,
  by_type: {}, errors: [], deferred: 0, provider_issue: null, alt_issue: null,
  vector_pending: 0, alt_embedded: 0, backfilled_primary: 0, backfilled_alt: 0, spaces_down: [], skipped_rows: 0,
});

export type WorkerOptions = {
  rpc: Rpc;
  keys?: AltKeys;                 // the free providers' API keys: the worker builds each space's embedder from them
  embed?: Embedder;               // test seam: the MAIN space's embedder (overrides keys)
  embedAlt?: Embedder;            // test seam: the second space's embedder
  altKeys?: AltKeys;              // back-compat name of `keys`
  fetchImpl?: typeof fetch;       // test seam for keys
  sleep?: (ms: number) => Promise<void>;   // test seam: pacing waits
  backfill?: boolean;             // default true: fill missing vectors after the queue
  workerId?: string;
  pipelineVersion?: string;       // tests override; production uses PIPELINE_VERSION
  model?: string;
  timeBudgetMs?: number;
  claimBatch?: number;
  maxItems?: number;              // stop after claiming this many (runner --limit)
  checkPipeline?: boolean;        // default true: refuse to run if SQL disagrees
  recordRun?: boolean;            // default true: one ai_ingest_runs row
  sources?: Record<string, CustomSource>;   // extra source types (tests)
  now?: () => number;
  log?: (msg: string) => void;
};

type BatchOptions = PlanOptions & {
  rpc: Rpc; embed?: Embedder; embedAlt?: Embedder; workerId: string; sources?: Record<string, CustomSource>;
  sleep?: (ms: number) => Promise<void>;
  state?: EmbedState;   // absent (older callers, tests): read from the database on first use
};

const DEFAULT_MAIN_SOURCES = ['kb_article', 'ai_doc', 'app_guide', 'report', 'tts_article'];
const DEFAULT_ALT_SOURCES = ['kb_article', 'ai_doc', 'app_guide', 'tts_article'];

const errText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 1000);
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function embedState(o: BatchOptions): Promise<EmbedState> {
  if (!o.state) {
    const s = (await o.rpc('ai_embed_settings').catch(() => null)) ?? {};
    const ready = async (space: Space) => (await o.rpc('ai_vector_ready', { p_space: space }).catch(() => true)) !== false;
    const altProvider: EmbedProvider | null = s.alt_provider === null || s.alt_provider === 'none' ? null
      : isAltProvider(s.alt_provider) ? s.alt_provider : (MAIN_PROVIDER === 'nvidia' ? 'gemini' : 'nvidia');
    const strs = (v: unknown, d: string[]) => (Array.isArray(v) ? v.map(String) : d);
    o.state = {
      settings: {
        main_provider: MAIN_PROVIDER, main_model: typeof s.model === 'string' ? s.model : DEFAULT_CONFIG.EMBED_MODEL,
        main_sources: strs(s.main_sources ?? s.free_sources, DEFAULT_MAIN_SOURCES),
        alt_provider: altProvider, alt_model: typeof s.alt_model === 'string' ? s.alt_model : (altProvider ? MODEL_LABEL[altProvider] : ''),
        alt_sources: strs(s.alt_sources, DEFAULT_ALT_SOURCES), alt_always: s.alt_always !== false,
      },
      deferred: { main: !(await ready('main')), alt: !(await ready('alt')) },
      failed: { main: false, alt: false },
      recovered: { main: false, alt: false },
    };
  }
  return o.state;
}

const embedderOf = (o: BatchOptions, space: Space) => (space === 'main' ? o.embed : o.embedAlt);
const isUsable = (o: BatchOptions, st: EmbedState, space: Space) =>
  !!embedderOf(o, space) && !st.deferred[space] && !st.failed[space] && (space === 'main' || !!st.settings.alt_provider);
const providerOf = (st: EmbedState, space: Space) => (space === 'main' ? st.settings.main_provider : st.settings.alt_provider);
const modelOf = (st: EmbedState, space: Space) => (space === 'main' ? st.settings.main_model : st.settings.alt_model);
const sourcesOf = (st: EmbedState, space: Space) => new Set(space === 'main' ? st.settings.main_sources : st.settings.alt_sources);

// How long to leave a failed space alone: the provider's own wait when it states one ("retry in 13h"),
// at most 6 h so a recovered key is noticed the same day; else 30 min for an account problem, 2 min otherwise.
export function deferSeconds(e: unknown, issue: ProviderIssue | null): number {
  const wait = (e as { retryAfterMs?: number })?.retryAfterMs ?? retryAfterMs(String((e as Error)?.message ?? e));
  const stated = wait != null ? Math.ceil(wait / 1000) + 5 : null;
  if (stated != null) return Math.min(Math.max(stated, 60), 21_600);
  return issue ? PROVIDER_DEFER_SECONDS : TRANSIENT_DEFER_SECONDS;
}

type Embedded = { vectors: number[][]; tokens: number; requests?: number };

// Embeds with one space's provider. On failure the space is marked failed for this run
// (never asked again in it) and DEFERRED in the database for a while: 30 min for an
// account problem (no quota, key refused, a limit of hours), 2 min for a passing rate limit
// or a transient error. A refusal of the INPUT itself (a 4xx other than 401/403/408/429) is not
// the provider's fault: it defers nothing and returns 'refused', so the backfill can isolate
// the bad row. A success clears an old deferral (ai_vector_ok).
async function tryEmbed(o: BatchOptions, space: Space, texts: string[], stats: RunStats): Promise<Embedded | 'refused' | null> {
  const st = await embedState(o);
  const embed = embedderOf(o, space)!;
  try {
    const r = await embed(texts);
    if (r.vectors.length !== texts.length) throw new Error(`embedder returned ${r.vectors.length} vectors for ${texts.length} texts`);
    if (!st.recovered[space]) {
      st.recovered[space] = true;
      await o.rpc('ai_vector_ok', { p_space: space }).catch(() => {});
    }
    return r;
  } catch (e) {
    const issue = providerAccountIssue(e);
    const status = Number((e as { status?: number })?.status);
    const refusedInput = !issue && status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status);
    const who = providerOf(st, space) ?? space;
    if (stats.errors.length < 10) stats.errors.push(`${who} embeddings (${space}): ${issue ?? (refusedInput ? 'refused input' : 'error')} (${errText(e).slice(0, 160)})`);
    if (refusedInput) return 'refused';
    st.failed[space] = true;
    if (issue) { if (space === 'main') stats.provider_issue = issue; else stats.alt_issue = issue; }
    if (!stats.spaces_down.includes(space)) stats.spaces_down.push(space);
    await o.rpc('ai_vector_defer', { p_space: space, p_seconds: deferSeconds(e, issue), p_error: errText(e).slice(0, 500) }).catch(() => {});
    return null;
  }
}

// Backfill/reconcile compare fingerprints in SQL against ai_pipeline_version()
// and ai_embed_model(); a worker built with other constants would re-enqueue
// or skip the wrong documents, so it does not run at all.
export async function assertPipeline(rpc: Rpc, o: PlanOptions): Promise<void> {
  const [pv, model] = [await rpc('ai_pipeline_version'), await rpc('ai_embed_model')];
  if (pv !== o.pipelineVersion || model !== o.model) {
    throw new Error(`pipeline mismatch: code ${o.pipelineVersion}/${o.model}, database ${pv}/${model}. Ship the migration that redefines ai_pipeline_version() with the code.`);
  }
}

export async function loadSources(rpc: Rpc, type: string, ids: string[] | null, custom?: CustomSource): Promise<Map<string, SourceRecord>> {
  const rows: SourceRecord[] = custom
    ? await custom.fetch(ids ?? [])
    : (await rpc('ai_ingest_source', { p_type: type, p_ids: ids, p_payload: true })) ?? [];
  return new Map(rows.map((r) => [r.source_id, r]));
}

export async function loadExisting(rpc: Rpc, type: string, ids: string[] | null): Promise<Map<string, ExistingDoc>> {
  const rows: ExistingDoc[] = (await rpc('ai_ingest_existing', { p_type: type, p_ids: ids })) ?? [];
  return new Map(rows.map((r) => [r.source_id, r]));
}

// Process one claimed batch. Exported for tests: items need not come from a
// claim as long as they are 'processing' and locked by workerId.
export async function processBatch(items: QueueItem[], o: BatchOptions, stats: RunStats): Promise<void> {
  const { rpc, workerId } = o;
  const fail = async (it: QueueItem, e: unknown) => {
    // No quota / a refused key (QA 2026-10-01 F3): not the item's fault. It
    // goes back to pending in 30 min without spending an attempt, and the run stops.
    const issue = providerAccountIssue(e);
    if (issue) {
      stats.provider_issue = issue;
      if (stats.errors.length < 10) stats.errors.push(`provider account: ${issue === 'quota' ? 'no quota left' : issue === 'auth' ? 'API key refused' : 'usage limit reached'} (${errText(e).slice(0, 120)})`);
      const held = await rpc('ai_ingest_defer', { p_id: it.id, p_worker: workerId, p_error: errText(e), p_delay_seconds: PROVIDER_DEFER_SECONDS });
      if (held === false) stats.lost_lock++; else stats.deferred++;
      return;
    }
    stats.failed++;
    if (stats.errors.length < 10) stats.errors.push(`${it.source_type}/${it.source_id}: ${errText(e)}`);
    const held = await rpc('ai_ingest_fail', { p_id: it.id, p_worker: workerId, p_error: errText(e) });
    if (held === false) stats.lost_lock++;
  };
  const known = (t: string) => isSourceType(t) || !!o.sources?.[t];

  // 0. A source switched off in ai_assistant_config.ingest_sources (mig 377):
  // its queued items complete with a soft delete (ai_ingest_write would refuse
  // them, and failing 5 times would only fill the failed list). The chunks
  // keep their vectors, so switching it back on re-embeds nothing unchanged.
  // Read per batch, so switching a source off takes effect mid-run.
  const enabled = new Set<string>((await rpc('ai_source_types')) ?? []);
  const live: QueueItem[] = [];
  for (const it of items) {
    if (enabled.has(it.source_type)) { live.push(it); continue; }
    try {
      const r = await rpc('ai_ingest_delete', { p_type: it.source_type, p_id: it.source_id, p_soft: true, p_queue_id: it.id, p_worker: workerId });
      if (r?.ok === true) {
        stats.disabled++;
        stats.succeeded++;
      } else {
        stats.lost_lock++;
      }
    } catch (e) {
      await fail(it, e);
    }
  }

  // 1. Live rows and stored documents, one call each per source type.
  const byType = new Map<string, QueueItem[]>();
  for (const it of live) (byType.get(it.source_type) ?? byType.set(it.source_type, []).get(it.source_type)!).push(it);
  const sources = new Map<string, Map<string, SourceRecord>>();
  const existing = new Map<string, Map<string, ExistingDoc>>();
  for (const [type, list] of [...byType]) {
    try {
      if (!known(type)) throw new Error(`unknown source_type ${type}`);
      const ids = [...new Set(list.map((i) => i.source_id))];
      sources.set(type, await loadSources(rpc, type, ids, o.sources?.[type]));
      existing.set(type, await loadExisting(rpc, type, ids));
    } catch (e) {
      for (const it of list) await fail(it, e);
      byType.delete(type);
    }
  }

  // 2. Plans.
  const plans: { it: QueueItem; plan: Plan }[] = [];
  for (const [type, list] of byType) {
    for (const it of list) {
      try {
        const plan = await planDocument(type, sources.get(type)!.get(it.source_id) ?? null,
          existing.get(type)!.get(it.source_id) ?? null, o, o.sources?.[type]);
        plans.push({ it, plan });
      } catch (e) {
        await fail(it, e);
      }
    }
  }

  // 3. One embedding pass per space for every new text in the batch. A failed
  // space never blocks the write: those chunks go in without that vector (pending,
  // keyword-searchable). Each space only gets the source types its provider may see.
  const vectors: Record<Space, Map<string, number[]>> = { main: new Map(), alt: new Map() };
  const texts = new Map<string, { text: string; type: string }>();
  for (const { it, plan } of plans) {
    if (plan.action === 'write') for (const c of plan.toEmbed) texts.set(c.content_hash, { text: c.embed_text, type: it.source_type });
  }
  if (texts.size) {
    const st = await embedState(o);
    const hashes = [...texts.keys()];
    for (const space of ['main', 'alt'] as Space[]) {
      if (!isUsable(o, st, space)) continue;
      const allowed = sourcesOf(st, space);
      const wanted = hashes.filter((h) => allowed.has(texts.get(h)!.type) && (space === 'main' || st.settings.alt_always || !vectors.main.has(h)));
      if (!wanted.length) continue;
      // A free tier's per-minute allowance: wait a few seconds, but leave a long wait to the backfill.
      const wait = embedderOf(o, space)!.waitMs?.() ?? 0;
      if (wait > 10_000) continue;
      if (wait > 0) await (o.sleep ?? realSleep)(wait);
      if (space === 'main') stats.embed_calls++;
      const r = await tryEmbed(o, space, wanted.map((h) => texts.get(h)!.text), stats);
      if (r && r !== 'refused') {
        wanted.forEach((h, i) => vectors[space].set(h, r.vectors[i]));
        if (space === 'main') { stats.embedded_chunks += wanted.length; stats.embed_tokens += r.tokens; stats.embed_requests += r.requests ?? 1; }
        else stats.alt_embedded += wanted.length;
      }
    }
  }

  // 4. Apply. Each RPC checks the lock and completes the item in its own transaction.
  for (const { it, plan } of plans) {
    try {
      const lock = { p_queue_id: it.id, p_worker: workerId };
      let ok = false;
      if (plan.action === 'skip' || plan.action === 'noop') {
        ok = (await rpc('ai_ingest_complete', { p_id: it.id, p_worker: workerId })) === true;
        if (ok && plan.action === 'skip') stats.skipped_unchanged++;
        if (ok && plan.action === 'noop') stats.noop++;
      } else if (plan.action === 'touch') {
        ok = (await rpc('ai_ingest_touch', { p_type: it.source_type, p_id: it.source_id, p_fp: plan.fp, ...lock }))?.ok === true;
        if (ok) stats.touched++;
      } else if (plan.action === 'delete') {
        ok = (await rpc('ai_ingest_delete', { p_type: it.source_type, p_id: it.source_id, p_soft: plan.soft, ...lock }))?.ok === true;
        if (ok) plan.soft ? stats.soft_deleted++ : stats.deleted++;
      } else {
        const altModel = (await embedState(o)).settings.alt_model;
        const chunks = plan.chunks.map((c) => ({
          ...c,
          embedding: vectors.main.get(c.content_hash) ?? null,
          ...(vectors.alt.has(c.content_hash) ? { embedding_alt: vectors.alt.get(c.content_hash), embed_model_alt: altModel } : {}),
        }));
        const w = await rpc('ai_ingest_write', { p_doc: plan.docRow, p_chunks: chunks, ...lock });
        ok = w?.ok === true;
        if (ok) {
          stats.written++;
          stats.reused_chunks += plan.stats.reusedMoved + plan.stats.reusedSameIndex;
          stats.vector_pending += Number(w.vector_pending ?? 0);
        }
      }
      if (ok) {
        stats.succeeded++;
        stats.by_type[it.source_type] = (stats.by_type[it.source_type] ?? 0) + 1;
      } else {
        stats.lost_lock++;   // another worker reclaimed it; our result is dropped
      }
    } catch (e) {
      await fail(it, e);
    }
  }
}

type PendingRow = { id: string; content_hash: string; embed_text: string };

// Embeds rows with one space; if the provider refuses the INPUT, halves the batch until
// the bad rows stand alone (they are skipped and counted; the rest still get their vectors).
async function embedRows(o: BatchOptions, space: Space, rows: PendingRow[], stats: RunStats): Promise<Array<{ row: PendingRow; vector: number[] }>> {
  if (!rows.length) return [];
  const r = await tryEmbed(o, space, rows.map((x) => x.embed_text), stats);
  if (r === 'refused') {
    if (rows.length === 1) { stats.skipped_rows++; return []; }
    const mid = rows.length >> 1;
    return [...await embedRows(o, space, rows.slice(0, mid), stats), ...await embedRows(o, space, rows.slice(mid), stats)];
  }
  if (!r) return [];
  if (space === 'main') { stats.embed_tokens += r.tokens; }
  stats.embed_requests += r.requests ?? 1;
  return rows.map((row, i) => ({ row, vector: r.vectors[i] }));
}

// Fills missing vectors in batches until a space runs out, the time budget ends,
// or its provider fails. The main space is served first (it is the one searches rely
// on), then the second. SQL serves the `none` bucket (no vector at all) first and
// returns nothing during quiet hours, so "waiting for vectors" drains to zero across
// ticks. A free tier's per-minute allowance is waited out only if it fits in the budget:
// `more(ms)` asks whether ms of budget remain.
export async function backfillVectors(o: BatchOptions, stats: RunStats, more: (needMs?: number) => boolean, log?: (m: string) => void): Promise<void> {
  const st = await embedState(o);
  const sleep = o.sleep ?? realSleep;
  for (const space of ['main', 'alt'] as Space[]) {
    for (let i = 0; i < BACKFILL.maxBatches && isUsable(o, st, space); i++) {
      const wait = embedderOf(o, space)!.waitMs?.() ?? 0;
      if (!more(wait + 5000)) break;
      if (wait > 0) await sleep(wait);
      let rows: PendingRow[];
      try { rows = (await o.rpc('ai_vector_pending', { p_space: space, p_limit: BACKFILL.batch[space] })) ?? []; } catch { break; }   // a database before mig 432
      if (!rows.length) break;
      const got = await embedRows(o, space, rows, stats);
      if (!got.length) break;
      const filled = Number(await o.rpc('ai_vector_fill', {
        p_space: space, p_model: modelOf(st, space),
        p_rows: got.map((x) => ({ id: x.row.id, content_hash: x.row.content_hash, embedding: x.vector })),
      }) ?? 0);
      if (space === 'main') stats.backfilled_primary += filled; else stats.backfilled_alt += filled;
      log?.(`backfill ${space}: ${filled} vector(s)`);
      if (rows.length < BACKFILL.batch[space]) break;
    }
  }
}

export async function runWorker(opts: WorkerOptions): Promise<RunStats> {
  const now = opts.now ?? (() => Date.now());
  const t0 = now();
  const o: BatchOptions = {
    rpc: opts.rpc,
    embed: opts.embed,
    embedAlt: opts.embedAlt,
    workerId: opts.workerId ?? `ingest-${crypto.randomUUID()}`,
    pipelineVersion: opts.pipelineVersion ?? PIPELINE_VERSION,
    model: opts.model ?? DEFAULT_CONFIG.EMBED_MODEL,
    sources: opts.sources,
    sleep: opts.sleep,
  };
  const budget = opts.timeBudgetMs ?? DEFAULT_CONFIG.WORKER_TIME_BUDGET_MS;
  const batch = opts.claimBatch ?? DEFAULT_CONFIG.CLAIM_BATCH;
  const stats = emptyStats();
  const record = opts.recordRun !== false;
  let runId: unknown = null;
  let error: string | null = null;
  const keys = opts.keys ?? opts.altKeys;

  try {
    if (opts.checkPipeline !== false) await assertPipeline(o.rpc, o);
    // Each space's provider is a setting (mig 432): read the settings, THEN build the embedders from the
    // keys. Whether a space is usable is computed from the embedders when needed (isUsable), not stored,
    // so the build order cannot leave a working fallback marked down (the 2026-10 incident, where
    // nothing was embedded for a month while a working key sat unused).
    if (keys) {
      const st = await embedState(o);
      o.embed ??= providerEmbedder(st.settings.main_provider, keys, { fetchImpl: opts.fetchImpl, sleep: opts.sleep, now });
      if (st.settings.alt_provider) o.embedAlt ??= providerEmbedder(st.settings.alt_provider, keys, { fetchImpl: opts.fetchImpl, sleep: opts.sleep, now });
      // A provider with no key is a visible state, not silence: 'down: no API key', retried hourly.
      for (const space of ['main', 'alt'] as Space[]) {
        const provider = providerOf(st, space);
        if (provider && !embedderOf(o, space) && !st.deferred[space]) {
          st.deferred[space] = true;
          stats.errors.push(`${provider} embeddings (${space}): no API key configured`);
          await o.rpc('ai_vector_defer', { p_space: space, p_seconds: NO_KEY_DEFER_SECONDS, p_error: `no API key configured for ${provider}` }).catch(() => {});
        }
      }
    }
    if (record) runId = await o.rpc('ai_ingest_run_start', { p_kind: 'ingest', p_worker: o.workerId });
    while (now() - t0 < budget) {
      const room = opts.maxItems === undefined ? batch : Math.min(batch, opts.maxItems - stats.claimed);
      if (room <= 0) break;
      const items: QueueItem[] = (await o.rpc('ai_ingest_claim', { p_limit: room, p_worker: o.workerId })) ?? [];
      if (!items.length) break;
      stats.claimed += items.length;
      await processBatch(items, o, stats);
      opts.log?.(`batch of ${items.length}: ok ${stats.succeeded}, failed ${stats.failed}, embedded ${stats.embedded_chunks}, pending vectors ${stats.vector_pending}`);
    }
    if (opts.backfill !== false && now() - t0 < budget) await backfillVectors(o, stats, (need = 0) => now() - t0 + need < budget, opts.log);
  } catch (e) {
    error = errText(e);
    throw e;
  } finally {
    if (record && runId !== null) {
      await o.rpc('ai_ingest_run_finish', { p_id: runId, p_stats: { ...stats, ms: now() - t0 }, p_error: error }).catch(() => {});
    }
  }
  return stats;
}
