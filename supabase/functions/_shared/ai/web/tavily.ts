// Tavily: web search and page extraction (https://api.tavily.com).
//
// Chosen for the runtime integration on Tavily's own advice in
// tavily.com/agent-setup/SKILL.md: "Never use the CLI as production runtime
// integration; use official SDKs or REST API instead." The REST API is called
// directly rather than via @tavily/core, because the edge functions import by
// URL and we already own the retry/credit plumbing.
//
// Credits are real money, so every call reports `usage.credits` back to the
// caller and Buddy logs it (ai_usage_log, kind 'web_search' / 'web_extract').

import type { WebHit, WebPage } from './types.ts';

const BASE = 'https://api.tavily.com';

export type TavilyOpts = {
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export class TavilyError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; this.name = 'TavilyError'; }
}

async function post(path: string, body: unknown, o: TavilyOpts): Promise<any> {
  const doFetch = o.fetchImpl ?? fetch;
  const res = await doFetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${o.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
  });
  const text = await res.text();
  if (!res.ok) {
    // 432/433 are Tavily's plan/credit codes; 401 a bad key. The message is
    // surfaced to the admin, never to an employee.
    const detail = (() => { try { return JSON.parse(text)?.detail?.error ?? JSON.parse(text)?.detail ?? text; } catch { return text; } })();
    throw new TavilyError(String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300), res.status);
  }
  try { return JSON.parse(text); } catch { throw new TavilyError('Tavily returned a non-JSON body', res.status); }
}

export type TavilySearchArgs = {
  query: string;
  maxResults?: number;              // 0-20, API default 10
  topic?: 'general' | 'news' | 'finance';
  searchDepth?: 'basic' | 'advanced' | 'fast' | 'ultra-fast';
  timeRange?: 'day' | 'week' | 'month' | 'year' | null;
  includeDomains?: string[];        // up to 300
  excludeDomains?: string[];        // up to 150
  country?: string | null;
};

export async function tavilySearch(a: TavilySearchArgs, o: TavilyOpts): Promise<{ hits: WebHit[]; answer: string | null; credits: number }> {
  const body: Record<string, unknown> = {
    query: a.query,
    max_results: Math.max(1, Math.min(20, a.maxResults ?? 6)),
    topic: a.topic ?? 'general',
    search_depth: a.searchDepth ?? 'basic',
    // Tavily's own one-paragraph answer: a useful summary, but it is still
    // treated as a source to cite, never as the final answer.
    include_answer: 'basic',
    include_raw_content: false,
    include_images: false,
  };
  if (a.timeRange) body.time_range = a.timeRange;
  if (a.includeDomains?.length) body.include_domains = a.includeDomains.slice(0, 300);
  if (a.excludeDomains?.length) body.exclude_domains = a.excludeDomains.slice(0, 150);
  if (a.country) { body.country = a.country; body.topic = 'general'; }   // country applies to general only
  const j = await post('/search', body, o);
  // Array.isArray, not `?? []`: a malformed reply would otherwise throw
  // "r.map is not a function" and lose the real error (QA).
  const hits: WebHit[] = (Array.isArray(j?.results) ? j.results : []).map((r: any) => ({
    title: String(r?.title ?? '').slice(0, 300) || String(r?.url ?? ''),
    url: String(r?.url ?? ''),
    snippet: String(r?.content ?? '').slice(0, 1200),
    publishedAt: r?.published_date ? String(r.published_date) : null,
    score: typeof r?.score === 'number' ? r.score : null,
    engine: 'tavily',
  })).filter((h: WebHit) => !!h.url);
  return {
    hits,
    answer: typeof j?.answer === 'string' && j.answer.trim() ? j.answer.trim().slice(0, 2000) : null,
    credits: credits(j),
  };
}

// A non-numeric usage.credits must not become NaN: it is written to
// ai_usage_log, where NaN would poison the Boss's usage totals (QA).
const credits = (j: any): number => {
  const n = Number(j?.usage?.credits);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

export async function tavilyExtract(urls: string[], o: TavilyOpts & { query?: string; depth?: 'basic' | 'advanced' }):
  Promise<{ pages: WebPage[]; failed: { url: string; error: string }[]; credits: number }> {
  const body: Record<string, unknown> = {
    urls: urls.slice(0, 20),
    extract_depth: o.depth ?? 'basic',
    format: 'markdown',
    include_images: false,
    include_usage: true,
  };
  if (o.query) body.query = o.query;
  const j = await post('/extract', body, o);
  // HTTP 200 can still carry an empty results array when every URL failed, so
  // both lists are always read (Tavily's own note on the endpoint).
  return {
    pages: (Array.isArray(j?.results) ? j.results : []).map((r: any) => ({
      url: String(r?.url ?? ''),
      title: null,
      text: String(r?.raw_content ?? ''),
      source: 'tavily' as const,
    })).filter((p: WebPage) => !!p.url && !!p.text),
    failed: (Array.isArray(j?.failed_results) ? j.failed_results : []).map((f: any) => ({ url: String(f?.url ?? ''), error: String(f?.error ?? 'extraction failed').slice(0, 200) })),
    credits: credits(j),
  };
}
