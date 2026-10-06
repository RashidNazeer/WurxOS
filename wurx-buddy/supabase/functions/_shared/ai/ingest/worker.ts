// The ingest worker (A§9.5), runtime-neutral: the ai-ingest edge function
// (Deno) and scripts/ingest.mjs (Node) both call runWorker with their own Rpc
// and embedder.
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
// OpenAI has no credits (mig 402): ingestion still goes on. New chunks are
// written with `embedding` NULL (vector_pending) so the keyword arm finds them
// at once; when the free provider may see their source type they also get a
// NVIDIA vector (embedding_alt). After the queue, backfillVectors() fills
// pending vectors in small batches whenever a provider works again, and defers
// a space for 30 min on an account problem (ai_vector_defer).

import { DEFAULT_CONFIG, PIPELINE_VERSION } from '../config.ts';
import { altEmbedOptions, altKeysFor, embedWithKeys, isAltProvider, ALT_MODEL_LABEL, type AltKeys, type AltProvider } from '../embedder.ts';
import { providerAccountIssue, type ProviderIssue } from '../providerErrors.ts';
import { SOURCE_TYPES } from '../extractors/index.ts';
import type { SourceType } from '../extractors/index.ts';
import type { ExistingDoc, QueueItem, Rpc, SourceRecord } from './db.ts';
import { planDocument } from './plan.ts';
import type { CustomSource, Plan, PlanOptions } from './plan.ts';

// An OpenAI account problem defers items this long (they keep all 5 attempts).
export const PROVIDER_DEFER_SECONDS = 1800;

export const isSourceType = (t: string): t is SourceType => (SOURCE_TYPES as string[]).includes(t);

// requests = HTTP calls made (retries included), for ai_ingest_runs.stats.embed_requests.
export type Embedder = (texts: string[]) => Promise<{ vectors: number[][]; tokens: number; requests?: number }>;

// One key, or [primary, fallback]: the fallback key is tried on an account problem.
export function openAiEmbedder(keys: string | Array<string | null | undefined>, model: string = DEFAULT_CONFIG.EMBED_MODEL, fetchImpl?: typeof fetch): Embedder {
  return async (texts) => {
    const r = await embedWithKeys(texts, Array.isArray(keys) ? keys : [keys], { model, fetchImpl });
    return { vectors: r.vectors, tokens: r.usage.totalTokens, requests: r.requests };
  };
}

// The second vector space (mig 408): the provider chosen in
// ai_assistant_config.embed_alt_provider, into embedding_alt only. One model
// per column, so the keys of ONE provider are tried, never the other's.
export function altEmbedder(provider: AltProvider, keys: AltKeys, fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void>): Embedder | undefined {
  const list = altKeysFor(provider, keys);
  if (!list.some(Boolean)) return undefined;
  return async (texts) => {
    const r = await embedWithKeys(texts, list, altEmbedOptions(provider, 'passage', { fetchImpl, sleep }));
    return { vectors: r.vectors, tokens: r.usage.totalTokens, requests: r.requests };
  };
}

// Back-compat for callers that pass NVIDIA keys directly (scripts, tests).
export const nvidiaEmbedder = (keys: Array<string | null | undefined>, fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void>): Embedder =>
  altEmbedder('nvidia', { nvidia: keys[0], nvidia2: keys[1] }, fetchImpl, sleep)!;

export type EmbedSettings = { alt_always: boolean; free_sources: string[]; alt_provider: AltProvider; alt_model: string };

// Per run: which spaces answered, so a dead provider is asked once, not per batch.
type EmbedState = { settings: EmbedSettings; primaryDown: boolean; altDown: boolean };

// Per run: enough batches to drain dev's backlog in a few ticks, bounded by the
// time budget. The `none` bucket (no vector at all) is served first by SQL.
export const BACKFILL = { primaryBatch: 64, primaryBatches: 8, altBatch: 32, altBatches: 20 };

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
  embedded_chunks: number;
  embed_tokens: number;
  embed_calls: number;      // embedder invocations (one per batch that had new text)
  embed_requests: number;   // HTTP requests to the embeddings API
  reused_chunks: number;
  by_type: Record<string, number>;
  errors: string[];
  deferred: number;                     // put back, attempt not spent: an account problem outside embedding
  provider_issue: ProviderIssue | null; // OpenAI: 'quota' (no credits) | 'auth' (key refused) | 'limit' (a wait of hours)
  alt_issue: ProviderIssue | null;      // the same for NVIDIA
  vector_pending: number;               // chunks written without an OpenAI vector
  alt_embedded: number;                 // chunks given an NVIDIA vector while ingesting
  backfilled_primary: number;           // pending chunks given their OpenAI vector
  backfilled_alt: number;               // chunks given an NVIDIA vector by the backfill
};

export const emptyStats = (): RunStats => ({
  claimed: 0, succeeded: 0, failed: 0, skipped_unchanged: 0, touched: 0, written: 0, deleted: 0, soft_deleted: 0,
  noop: 0, disabled: 0, lost_lock: 0, embedded_chunks: 0, embed_tokens: 0, embed_calls: 0, embed_requests: 0, reused_chunks: 0,
  by_type: {}, errors: [], deferred: 0, provider_issue: null, alt_issue: null,
  vector_pending: 0, alt_embedded: 0, backfilled_primary: 0, backfilled_alt: 0,
});

export type WorkerOptions = {
  rpc: Rpc;
  embed: Embedder;                // OpenAI → ai_chunks.embedding
  embedAlt?: Embedder;            // the alt space's embedder, if the caller built it
  altKeys?: AltKeys;              // or its keys: the provider comes from the config (mig 408)
  fetchImpl?: typeof fetch;       // test seam for altKeys
  backfill?: boolean;             // default true: fill pending vectors after the queue
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
  rpc: Rpc; embed: Embedder; embedAlt?: Embedder; workerId: string; sources?: Record<string, CustomSource>;
  state?: EmbedState;   // absent (older callers, tests): read from the database on first use
};

async function embedState(o: BatchOptions): Promise<EmbedState> {
  if (!o.state) {
    const s = (await o.rpc('ai_embed_settings').catch(() => null)) ?? {};
    const ready = async (space: string) => (await o.rpc('ai_vector_ready', { p_space: space }).catch(() => true)) !== false;
    const provider: AltProvider = isAltProvider(s.alt_provider) ? s.alt_provider : 'nvidia';
    o.state = {
      settings: { alt_always: s.alt_always === true, free_sources: Array.isArray(s.free_sources) ? s.free_sources : [],
        alt_provider: provider, alt_model: typeof s.alt_model === 'string' ? s.alt_model : ALT_MODEL_LABEL[provider] },
      primaryDown: !(await ready('primary')),
      altDown: !o.embedAlt || !(await ready('alt')),
    };
  }
  return o.state;
}

// Embeds with one provider; on an account problem marks the space down for this
// run and defers it (ai_vector_defer), so neither the queue nor the tick keeps
// asking a provider that has no credits.
async function tryEmbed(o: BatchOptions, space: 'primary' | 'alt', embed: Embedder, texts: string[], stats: RunStats):
  Promise<{ vectors: number[][]; tokens: number; requests?: number } | null> {
  const st = await embedState(o);
  try {
    const r = await embed(texts);
    if (r.vectors.length !== texts.length) throw new Error(`embedder returned ${r.vectors.length} vectors for ${texts.length} texts`);
    return r;
  } catch (e) {
    const issue = providerAccountIssue(e);
    const who = space === 'primary' ? 'OpenAI' : st.settings.alt_provider;
    if (stats.errors.length < 10) stats.errors.push(`${who} embeddings: ${issue ?? 'error'} (${errText(e).slice(0, 160)})`);
    if (issue) {
      if (space === 'primary') { st.primaryDown = true; stats.provider_issue = issue; } else { st.altDown = true; stats.alt_issue = issue; }
      await o.rpc('ai_vector_defer', { p_space: space, p_seconds: PROVIDER_DEFER_SECONDS, p_error: errText(e).slice(0, 500) }).catch(() => {});
    }
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

const errText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 1000);

// Process one claimed batch. Exported for tests: items need not come from a
// claim as long as they are 'processing' and locked by workerId.
export async function processBatch(items: QueueItem[], o: BatchOptions, stats: RunStats): Promise<void> {
  const { rpc, workerId } = o;
  const fail = async (it: QueueItem, e: unknown) => {
    // No credits / a refused key (QA 2026-10-01 F3): not the item's fault. It
    // goes back to pending in 30 min without spending an attempt, and the run stops.
    const issue = providerAccountIssue(e);
    if (issue) {
      stats.provider_issue = issue;
      if (stats.errors.length < 10) stats.errors.push(`OpenAI account: ${issue === 'quota' ? 'no credits left' : issue === 'auth' ? 'API key refused' : 'usage limit reached'} (${errText(e).slice(0, 120)})`);
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
  // space never blocks the write: those chunks go in without that vector.
  const vectors = new Map<string, number[]>();
  const altVectors = new Map<string, number[]>();
  const texts = new Map<string, { text: string; type: string }>();
  for (const { it, plan } of plans) {
    if (plan.action === 'write') for (const c of plan.toEmbed) texts.set(c.content_hash, { text: c.embed_text, type: it.source_type });
  }
  if (texts.size) {
    const st = await embedState(o);
    const hashes = [...texts.keys()];
    if (!st.primaryDown) {
      stats.embed_calls++;
      const r = await tryEmbed(o, 'primary', o.embed, hashes.map((h) => texts.get(h)!.text), stats);
      if (r) {
        hashes.forEach((h, i) => vectors.set(h, r.vectors[i]));
        stats.embedded_chunks += hashes.length;
        stats.embed_tokens += r.tokens;
        stats.embed_requests += r.requests ?? 1;
      }
    }
    // Only source types the Owner allows to be sent to a free provider.
    const free = new Set(st.settings.free_sources);
    const altWanted = hashes.filter((h) => free.has(texts.get(h)!.type) && (st.settings.alt_always || !vectors.has(h)));
    if (altWanted.length && o.embedAlt && !st.altDown) {
      const r = await tryEmbed(o, 'alt', o.embedAlt, altWanted.map((h) => texts.get(h)!.text), stats);
      if (r) { altWanted.forEach((h, i) => altVectors.set(h, r.vectors[i])); stats.alt_embedded += altWanted.length; }
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
          embedding: vectors.get(c.content_hash) ?? null,
          ...(altVectors.has(c.content_hash) ? { embedding_alt: altVectors.get(c.content_hash), embed_model_alt: altModel } : {}),
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

// Fills missing vectors in batches until a space runs out, the time budget
// ends, or its provider has an account problem. SQL serves the `none` bucket
// (no vector at all) first and returns nothing during quiet hours, so
// "waiting for vectors" drains to zero across ticks.
// The alt space is filled for the free-provider source types only.
export async function backfillVectors(o: BatchOptions, stats: RunStats, more: () => boolean, log?: (m: string) => void): Promise<void> {
  const st = await embedState(o);
  const spaces = [
    { space: 'alt' as const, embed: o.embedAlt, down: () => st.altDown, batch: BACKFILL.altBatch, n: BACKFILL.altBatches, model: st.settings.alt_model },
    { space: 'primary' as const, embed: o.embed, down: () => st.primaryDown, batch: BACKFILL.primaryBatch, n: BACKFILL.primaryBatches, model: o.model },
  ];
  for (const s of spaces) {
    if (!s.embed) continue;
    for (let i = 0; i < s.n && more() && !s.down(); i++) {
      let rows: Array<{ id: string; content_hash: string; embed_text: string }>;
      try { rows = (await o.rpc('ai_vector_pending', { p_space: s.space, p_limit: s.batch })) ?? []; } catch { return; }   // a database before mig 402
      if (!rows.length) break;
      const r = await tryEmbed(o, s.space, s.embed, rows.map((x) => x.embed_text), stats);
      if (!r) break;
      const filled = Number(await o.rpc('ai_vector_fill', {
        p_space: s.space, p_model: s.model,
        p_rows: rows.map((x, j) => ({ id: x.id, content_hash: x.content_hash, embedding: r.vectors[j] })),
      }) ?? 0);
      if (s.space === 'primary') {
        stats.backfilled_primary += filled;
        stats.embed_tokens += r.tokens;
        stats.embed_requests += r.requests ?? 1;
      } else {
        stats.backfilled_alt += filled;
      }
      log?.(`backfill ${s.space}: ${filled} vector(s)`);
      if (rows.length < s.batch) break;
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
  };
  const budget = opts.timeBudgetMs ?? DEFAULT_CONFIG.WORKER_TIME_BUDGET_MS;
  const batch = opts.claimBatch ?? DEFAULT_CONFIG.CLAIM_BATCH;
  const stats = emptyStats();
  const record = opts.recordRun !== false;
  let runId: unknown = null;
  let error: string | null = null;

  try {
    if (opts.checkPipeline !== false) await assertPipeline(o.rpc, o);
    // The alt space's provider is a setting (mig 408), so build its embedder
    // once the settings are read, from the keys the caller handed over.
    if (!o.embedAlt && opts.altKeys) {
      const st = await embedState(o);
      o.embedAlt = altEmbedder(st.settings.alt_provider, opts.altKeys, opts.fetchImpl);
      st.altDown = !o.embedAlt || st.altDown;
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
    if (opts.backfill !== false && now() - t0 < budget) await backfillVectors(o, stats, () => now() - t0 < budget, opts.log);
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
