// SearXNG: the self-hosted meta-search engine (https://docs.searxng.org).
//
// The instance URL is configuration, not a secret: ai_assistant_config.searxng_url,
// set by the Boss or a developer in Settings › Wurx Buddy › Web. There is no
// default, because pointing Buddy at a random public instance would leak every
// question the company asks to a stranger's logs.
//
// IMPORTANT for whoever runs the instance: `format=json` is refused with HTTP
// 403 unless the administrator adds `json` to `search.formats` in settings.yml.
// A bare SearXNG install only serves HTML, so the error below is the common
// first-run outcome and says exactly what to fix.

import { safeFetch } from './guard.ts';
import type { WebHit } from './types.ts';

export class SearxngError extends Error {
  status: number;
  hint: string | null;
  constructor(message: string, status: number, hint: string | null = null) {
    super(message); this.status = status; this.hint = hint; this.name = 'SearxngError';
  }
}

export type SearxngOpts = {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  allowHttp?: boolean;          // a LAN instance over plain http, if the admin opts in
};

export type SearxngArgs = {
  query: string;
  maxResults?: number;
  categories?: string;          // e.g. 'general', 'news', 'it'
  language?: string;            // e.g. 'en'
  timeRange?: 'day' | 'month' | 'year' | null;   // SearXNG supports only these three
  safesearch?: 0 | 1 | 2;
};

// POST is used (form-encoded, as the API docs specify) so the query never lands
// in the instance's access log as a URL.
export async function searxngSearch(a: SearxngArgs, o: SearxngOpts): Promise<{ hits: WebHit[] }> {
  const base = String(o.baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!base) throw new SearxngError('no SearXNG URL is configured', 0);
  const endpoint = /\/search$/.test(base) ? base : `${base}/search`;
  const form = new URLSearchParams({
    q: a.query,
    format: 'json',
    categories: a.categories ?? 'general',
    language: a.language ?? 'en',
    pageno: '1',
    safesearch: String(a.safesearch ?? 1),
  });
  if (a.timeRange) form.set('time_range', a.timeRange);

  const { res } = await safeFetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form.toString(),
    fetchImpl: o.fetchImpl,
    // This host came from an ADMIN typing it into Settings, not from the model
    // or a web page, so a private LAN address is legitimate here and nowhere
    // else. Without allowPrivate the allow-http toggle was a lie: it relaxed
    // only the scheme, so http://192.168.1.20:8080 was still refused (QA).
    // Loopback stays refused either way — the edge function's own localhost
    // cannot be the company's SearXNG.
    allowHttp: o.allowHttp === true,
    allowPrivate: o.allowHttp === true,
    signal: AbortSignal.timeout(o.timeoutMs ?? 12_000),
  });
  const text = await res.text();
  if (!res.ok) {
    const hint = res.status === 403
      ? "SearXNG refuses format=json until the instance administrator adds `json` to `search.formats` in settings.yml and restarts it."
      : res.status === 429 ? 'The SearXNG instance is rate-limiting us.' : null;
    throw new SearxngError(`SearXNG returned HTTP ${res.status}`, res.status, hint);
  }
  let j: any;
  try { j = JSON.parse(text); } catch {
    // An HTML page here means the URL points at the web UI with JSON disabled.
    throw new SearxngError('SearXNG did not return JSON (is `json` enabled in search.formats?)', res.status,
      'Add `json` to `search.formats` in the instance settings.yml.');
  }
  const max = Math.max(1, Math.min(20, a.maxResults ?? 6));
  // A malformed reply must read as "no results", not crash with
  // "r.map is not a function" (QA).
  const raw: any[] = Array.isArray(j?.results) ? j.results : [];
  const hits: WebHit[] = raw.slice(0, max).map((r: any) => ({
    title: String(r?.title ?? '').slice(0, 300) || String(r?.url ?? ''),
    url: String(r?.url ?? ''),
    snippet: String(r?.content ?? '').slice(0, 1200),
    publishedAt: r?.publishedDate ? String(r.publishedDate) : null,
    score: typeof r?.score === 'number' ? r.score : null,
    engine: `searxng${r?.engine ? `:${r.engine}` : ''}`,
  })).filter((h: WebHit) => !!h.url);
  return { hits };
}
