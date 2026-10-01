// One call of the weekly TikTok Shop Academy re-crawl (mig 380 state machine),
// runtime-neutral: the tts-crawl edge function runs it with supabase-js, the
// tests with a pg client inside a rolled-back transaction.
//
//   lease → discover (sitemap → items) | crawl (due pages, one attempt each,
//   ~2.5 s apart) | finalize (records in whole-id groups → crawlToRows, the
//   importer's winner rules → ai_tts_apply; then ai_crawl_finish) → release.
//
// Everything is resumable: a page's outcome, and each finalize group, is saved
// as it happens, so a call cut short (time budget, crash) loses at most one
// page. Retries and backoff live in the database (ai_crawl_put), not in sleeps.

import type { Rpc } from '../ingest/db.ts';
import { crawlToRows } from '../ingest/ttsImport.ts';
import type { CrawlItem } from './ttsPages.ts';
import { classifyPage, essayUrl, pageRecords, sitemapItems, TTS_SITEMAP, TTS_UA } from './ttsPages.ts';

export type Fetcher = (url: string, accept: string) => Promise<{ status: number; text: string }>;

export type CrawlOptions = {
  rpc: Rpc;
  fetch: Fetcher;                 // ONE attempt, with its own timeout
  workerId: string;
  budgetMs?: number;              // work per call; the edge limit is 150 s
  delayMs?: number;               // politeness gap between requests (+ jitter)
  jitterMs?: number;
  finalizeGroup?: number;         // ids per finalize page
  followLinks?: boolean;          // default true
  limitDiscovery?: number;        // tests: keep only the first n sitemap items
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  log?: (msg: string) => void;
};

export type CrawlCallResult = {
  status: string;                 // the crawl's state when the call ended, or 'idle' / 'busy'
  pages: number;
  outcomes: Record<string, number>;
  applied?: number;
  finished?: unknown;
  stopped?: string;               // why the call ended early
};

export const CRAWL_DEFAULTS = { budgetMs: 100_000, delayMs: 2500, jitterMs: 1000, finalizeGroup: 100 };
// Finalize a group only with this much time left: one group is a few seconds.
const FINALIZE_RESERVE_MS = 15_000;

// A fetch attempt with a timeout, for the edge function and Node alike.
export function httpFetcher(timeoutMs = 20_000, fetchImpl: typeof fetch = fetch): Fetcher {
  return async (url, accept) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { headers: { 'User-Agent': TTS_UA, 'Accept-Language': 'en-US,en', Accept: accept }, signal: ctrl.signal });
      return { status: res.status, text: await res.text() };
    } finally { clearTimeout(t); }
  };
}

export async function runCrawl(o: CrawlOptions): Promise<CrawlCallResult> {
  const now = o.now ?? (() => Date.now());
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = o.random ?? Math.random;
  const budget = o.budgetMs ?? CRAWL_DEFAULTS.budgetMs;
  const delay = o.delayMs ?? CRAWL_DEFAULTS.delayMs;
  const jitter = o.jitterMs ?? CRAWL_DEFAULTS.jitterMs;
  const t0 = now();
  const left = () => budget - (now() - t0);
  const W = o.workerId;
  const out: CrawlCallResult = { status: 'idle', pages: 0, outcomes: {} };

  let last: number | null = null;
  const politeFetch: Fetcher = async (url, accept) => {
    const wait = last === null ? 0 : last + delay + random() * jitter - now();
    if (wait > 0) await sleep(wait);
    last = now();
    return o.fetch(url, accept);
  };
  const call = async (fn: string, args: Record<string, unknown>) => {
    const r = await o.rpc(fn, { p_worker: W, ...args });
    if (r && r.ok === false) throw Object.assign(new Error(`${fn}: ${r.reason}`), { reason: r.reason });
    return r;
  };

  const lease = await o.rpc('ai_crawl_lease', { p_worker: W });
  if (!lease) {
    out.status = 'idle_or_busy';
    return out;
  }
  out.status = lease.status;
  // The gap holds across calls too (mig 384): the previous call's last fetch,
  // measured on the database clock.
  if (typeof lease.since_last_fetch_ms === 'number') last = now() - lease.since_last_fetch_ms;
  try {
    if (lease.status === 'discover') {
      let items: CrawlItem[] = [];
      try {
        const r = await politeFetch(TTS_SITEMAP, 'application/json');
        if (r.status >= 400) throw new Error(`sitemap HTTP ${r.status}`);
        items = sitemapItems(JSON.parse(r.text));
        if (!items.length) throw new Error('sitemap listed no pages');
      } catch (e) {
        await call('ai_crawl_note_error', { p_error: `sitemap: ${String((e as Error)?.message ?? e)}` });
        out.stopped = 'sitemap failed';
        return out;
      }
      if (o.limitDiscovery !== undefined) items = items.slice(0, o.limitDiscovery);
      await call('ai_crawl_add_items', { p_items: items });
      o.log?.(`discovered ${items.length} pages`);
      out.status = 'crawl';
    }

    while (left() > 0) {
      const next = await call('ai_crawl_next', { p_limit: 5 });
      out.status = next.status;
      if (next.status === 'finalize') break;
      if (!next.items.length) { out.stopped = `waiting for ${next.waiting} page(s) to retry`; break; }
      for (const item of next.items as CrawlItem[]) {
        if (left() <= 0) break;
        const route = item.kind === 'essay' ? 'essay/page' : 'course/page';
        let res;
        try {
          const r = await politeFetch(item.url, 'text/html');
          res = classifyPage(r.status, r.text, route);
        } catch (e) {
          res = { kind: 'retry' as const, reason: (e as Error)?.name === 'AbortError' ? 'timeout' : String((e as Error)?.message ?? e).slice(0, 200) };
        }
        out.pages++;
        if (res.kind === 'ok') {
          const { records, links } = pageRecords(item, res.data);
          if (links.length && o.followLinks !== false) {
            await call('ai_crawl_add_items', { p_items: links.map((id) => ({ key: `essay:${id}`, kind: 'essay', item_id: id, url: essayUrl(id), discovered: true })) });
          }
          await call('ai_crawl_put', { p_key: item.key, p_outcome: 'done', p_records: records });
          out.outcomes.done = (out.outcomes.done ?? 0) + 1;
        } else if (res.kind === 'dead') {
          await call('ai_crawl_put', { p_key: item.key, p_outcome: 'dead' });
          out.outcomes.dead = (out.outcomes.dead ?? 0) + 1;
        } else {
          const r = await call('ai_crawl_put', { p_key: item.key, p_outcome: 'retry', p_error: res.reason });
          out.outcomes[r.status === 'failed' ? 'failed' : 'retry'] = (out.outcomes[r.status === 'failed' ? 'failed' : 'retry'] ?? 0) + 1;
        }
      }
    }

    if (out.status === 'finalize') {
      // Resume after the last group a previous call applied (null: none yet).
      let after: string | null = lease.status === 'finalize' ? lease.finalize_after ?? null : null;
      out.applied = 0;
      while (left() > FINALIZE_RESERVE_MS) {
        const page = await call('ai_crawl_read_records', { p_after: after, p_limit: o.finalizeGroup ?? CRAWL_DEFAULTS.finalizeGroup });
        if (!page.records.length) {
          out.finished = (await call('ai_crawl_finish', {})).stats;
          out.status = 'idle';
          break;
        }
        const plan = await crawlToRows(page.records);
        await call('ai_tts_apply', { p_rows: plan.rows, p_last: page.last,
          p_stats: { records: plan.records, duplicate_ids: plan.duplicateIds, skipped_empty: plan.skippedEmpty.length } });
        out.applied += plan.rows.length;
        after = page.last;
      }
      if (out.status === 'finalize') out.stopped = 'time budget (finalize continues next call)';
    } else if (left() <= 0) {
      out.stopped = 'time budget';
    }
  } catch (e) {
    if ((e as { reason?: string }).reason === 'lost_lease') { out.stopped = 'lost the lease'; return out; }
    throw e;
  } finally {
    await o.rpc('ai_crawl_release', { p_worker: W }).catch(() => {});
  }
  return out;
}
