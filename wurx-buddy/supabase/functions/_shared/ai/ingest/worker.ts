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

import { DEFAULT_CONFIG, PIPELINE_VERSION } from '../config.ts';
import { embedTexts } from '../embedder.ts';
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

export function openAiEmbedder(apiKey: string, model: string = DEFAULT_CONFIG.EMBED_MODEL, fetchImpl?: typeof fetch): Embedder {
  return async (texts) => {
    const r = await embedTexts(texts, { apiKey, model, fetchImpl });
    return { vectors: r.vectors, tokens: r.usage.totalTokens, requests: r.requests };
  };
}

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
  deferred: number;                     // put back, attempt not spent: an OpenAI account problem
  provider_issue: ProviderIssue | null; // 'quota' (no credits) | 'auth' (key refused) | 'limit' (a wait of hours): the run stops
};

export const emptyStats = (): RunStats => ({
  claimed: 0, succeeded: 0, failed: 0, skipped_unchanged: 0, touched: 0, written: 0, deleted: 0, soft_deleted: 0,
  noop: 0, disabled: 0, lost_lock: 0, embedded_chunks: 0, embed_tokens: 0, embed_calls: 0, embed_requests: 0, reused_chunks: 0,
  by_type: {}, errors: [], deferred: 0, provider_issue: null,
});

export type WorkerOptions = {
  rpc: Rpc;
  embed: Embedder;
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

type BatchOptions = PlanOptions & { rpc: Rpc; embed: Embedder; workerId: string; sources?: Record<string, CustomSource> };

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

  // 3. One embedding pass for every new text in the batch.
  const vectors = new Map<string, number[]>();
  const texts = new Map<string, string>();
  for (const { plan } of plans) if (plan.action === 'write') for (const c of plan.toEmbed) texts.set(c.content_hash, c.embed_text);
  let embedError: unknown = null;
  if (texts.size) {
    try {
      const hashes = [...texts.keys()];
      stats.embed_calls++;
      const r = await o.embed(hashes.map((h) => texts.get(h)!));
      if (r.vectors.length !== hashes.length) throw new Error(`embedder returned ${r.vectors.length} vectors for ${hashes.length} texts`);
      hashes.forEach((h, i) => vectors.set(h, r.vectors[i]));
      stats.embedded_chunks += hashes.length;
      stats.embed_tokens += r.tokens;
      stats.embed_requests += r.requests ?? 1;
    } catch (e) {
      embedError = e;
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
        if (plan.toEmbed.length && embedError) throw embedError;
        const chunks = plan.chunks.map((c) => ({ ...c, embedding: vectors.get(c.content_hash) ?? null }));
        ok = (await rpc('ai_ingest_write', { p_doc: plan.docRow, p_chunks: chunks, ...lock }))?.ok === true;
        if (ok) { stats.written++; stats.reused_chunks += plan.stats.reusedMoved + plan.stats.reusedSameIndex; }
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

export async function runWorker(opts: WorkerOptions): Promise<RunStats> {
  const now = opts.now ?? (() => Date.now());
  const t0 = now();
  const o: BatchOptions = {
    rpc: opts.rpc,
    embed: opts.embed,
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
    if (record) runId = await o.rpc('ai_ingest_run_start', { p_kind: 'ingest', p_worker: o.workerId });
    while (now() - t0 < budget) {
      const room = opts.maxItems === undefined ? batch : Math.min(batch, opts.maxItems - stats.claimed);
      if (room <= 0) break;
      const items: QueueItem[] = (await o.rpc('ai_ingest_claim', { p_limit: room, p_worker: o.workerId })) ?? [];
      if (!items.length) break;
      stats.claimed += items.length;
      await processBatch(items, o, stats);
      if (stats.provider_issue) { opts.log?.(`stopping: OpenAI account problem (${stats.provider_issue}); ${stats.deferred} item(s) deferred`); break; }
      opts.log?.(`batch of ${items.length}: ok ${stats.succeeded}, failed ${stats.failed}, embedded ${stats.embedded_chunks}`);
    }
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
