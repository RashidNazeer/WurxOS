// Brave Search: the independent web index (https://api.search.brave.com).
//
// Worth having as a third provider because Brave runs its OWN crawler and
// index rather than reselling Google or Bing, so when it disagrees with the
// others it is genuinely a second opinion rather than the same answer twice.
//
// The machinery is here and wired all the way through to the settings screen,
// but there is no key yet (Owner, 2026-10-06: "I will add the api later").
// Until BRAVE_API_KEY is set, `brave` is simply not a usable provider and is
// skipped — exactly like Tavily without its key.
//
// Note the auth header is NOT a bearer token: Brave uses X-Subscription-Token.

import { safeFetch } from './guard.ts';
import type { WebHit } from './types.ts';

const ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

export class BraveError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; this.name = 'BraveError'; }
}

export type BraveOpts = {
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export type BraveArgs = {
  query: string;
  maxResults?: number;                                      // count, 1-20
  timeRange?: 'day' | 'week' | 'month' | 'year' | null;     // → freshness
  country?: string | null;                                  // 2-letter
  safesearch?: 'off' | 'moderate' | 'strict';
};

// Our shared recency vocabulary → Brave's freshness codes.
export const FRESHNESS: Record<string, string> = { day: 'pd', week: 'pw', month: 'pm', year: 'py' };

export const BRAVE_DEFAULT_COUNT = 6;
export function braveCount(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return BRAVE_DEFAULT_COUNT;
  return Math.max(1, Math.min(20, Math.floor(v)));
}

export async function braveSearch(a: BraveArgs, o: BraveOpts): Promise<{ hits: WebHit[] }> {
  const params = new URLSearchParams({
    q: a.query,
    // Floored and defended against a non-finite value: braveSearch is
    // exported, and count=7.5 or count=NaN is a 422 from Brave.
    count: String(braveCount(a.maxResults)),
    safesearch: a.safesearch ?? 'moderate',
    // Snippets only; we never want Brave's own generated answer presented as
    // fact, and the model can call open_web_page when a snippet is thin.
    text_decorations: 'false',
    spellcheck: 'true',
  });
  if (a.timeRange && FRESHNESS[a.timeRange]) params.set('freshness', FRESHNESS[a.timeRange]);
  if (a.country) params.set('country', String(a.country).slice(0, 2).toUpperCase());

  // Through safeFetch like everything else: the endpoint is a constant, but
  // this keeps one code path for redirects, timeouts and the guard.
  const { res } = await safeFetch(`${ENDPOINT}?${params.toString()}`, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      'accept-encoding': 'gzip',
      'x-subscription-token': o.apiKey,
    },
    fetchImpl: o.fetchImpl,
    signal: AbortSignal.timeout(o.timeoutMs ?? 12_000),
  });
  const text = await res.text();
  if (!res.ok) {
    const detail = (() => {
      try { const j = JSON.parse(text); return j?.error?.detail ?? j?.error?.meta?.plan ?? j?.message ?? text; }
      catch { return text; }
    })();
    throw new BraveError(String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300), res.status);
  }
  let j: any;
  try { j = JSON.parse(text); } catch { throw new BraveError('Brave returned a non-JSON body', res.status); }

  // Array.isArray throughout: a malformed reply must read as "no results"
  // rather than throwing "results.map is not a function".
  const raw: any[] = Array.isArray(j?.web?.results) ? j.web.results : [];
  const hits: WebHit[] = raw.map((r: any) => ({
    title: String(r?.title ?? '').slice(0, 300) || String(r?.url ?? ''),
    url: String(r?.url ?? ''),
    // extra_snippets is only present on some plans; the description is always there.
    snippet: [String(r?.description ?? ''), ...(Array.isArray(r?.extra_snippets) ? r.extra_snippets.map(String) : [])]
      .filter(Boolean).join(' ').slice(0, 1200),
    publishedAt: r?.page_age ? String(r.page_age) : (r?.age ? String(r.age) : null),
    score: null,                 // Brave returns no score; RRF-style ordering is positional
    engine: 'brave',
  })).filter((h: WebHit) => !!h.url);
  return { hits };
}
