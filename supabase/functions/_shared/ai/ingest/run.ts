// The ai-ingest function body, runtime-neutral (index.ts wraps it; tests run it
// under Node with a fake Rpc).
//
//   {mode:'drain'}  (default; what ai_ingest_tick posts every minute when work
//                   is claimable) → runWorker within the time budget.
//   {mode:'sweep'}  a manual trigger → ai_run_ingestion() (mig 379: its 5-minute
//                   and already-queued guards apply; as the service role it is
//                   recorded with triggered_by null), then drain in the time left.
//
// The whole call stays inside WORKER_TIME_BUDGET_MS (100 s), under the edge
// wall-clock limit (150 s on the free plan) and the tick's 150 s HTTP timeout.

import { DEFAULT_CONFIG } from '../config.ts';
import type { Rpc } from './db.ts';
import { runWorker } from './worker.ts';
import type { Embedder, RunStats } from './worker.ts';

export type IngestMode = 'drain' | 'sweep';

export type IngestResult = { mode: IngestMode; sweep?: unknown; stats?: RunStats; skipped_drain?: boolean };

// A missing or empty body is the tick's default; anything else must name a mode.
export function parseMode(body: unknown): IngestMode | null {
  if (body === null || body === undefined) return 'drain';
  if (typeof body !== 'object' || Array.isArray(body)) return null;
  const m = (body as { mode?: unknown }).mode;
  if (m === undefined) return 'drain';
  return m === 'drain' || m === 'sweep' ? m : null;
}

export async function runIngest(mode: IngestMode, o: {
  rpc: Rpc;
  embed: Embedder;
  embedAlt?: Embedder;      // NVIDIA → embedding_alt (mig 406)
  timeBudgetMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
}): Promise<IngestResult> {
  const now = o.now ?? (() => Date.now());
  const t0 = now();
  const budget = o.timeBudgetMs ?? DEFAULT_CONFIG.WORKER_TIME_BUDGET_MS;
  const out: IngestResult = { mode };
  if (mode === 'sweep') out.sweep = await o.rpc('ai_run_ingestion');
  const left = budget - (now() - t0);
  if (left <= 0) {
    out.skipped_drain = true;
    return out;
  }
  out.stats = await runWorker({ rpc: o.rpc, embed: o.embed, embedAlt: o.embedAlt, timeBudgetMs: left, now, log: o.log });
  return out;
}
