// Buddy's window on the open internet: search across the configured providers,
// and read one page.
//
// Provider order is config (ai_assistant_config.web_providers, mig 415); the
// default is SearXNG first, then Tavily. Rationale: SearXNG is the company's
// own instance, so it costs nothing and leaks nothing, and Tavily's credits are
// spent only when SearXNG is unconfigured, down, or came back empty. Both can
// run and have their results merged (`merge: true`).
//
// Nothing here decides WHETHER to go to the web. That is the model's call under
// the prompt rules, gated by web_search_enabled and web_allowed_roles.

import { checkUrl, safeFetch } from './guard.ts';
import { searxngSearch, SearxngError } from './searxng.ts';
import { tavilyExtract, tavilySearch, TavilyError } from './tavily.ts';
import { htmlToText } from './html.ts';
import type { WebHit, WebPage, WebSearchOutcome, WebUsage } from './types.ts';

export * from './types.ts';
export { checkUrl, safeFetch } from './guard.ts';

export type WebProvider = 'searxng' | 'tavily';
export const WEB_PROVIDERS: WebProvider[] = ['searxng', 'tavily'];
export const isWebProvider = (s: unknown): s is WebProvider => WEB_PROVIDERS.includes(s as WebProvider);

export type WebConfig = {
  enabled: boolean;
  providers: WebProvider[];       // in order; [] = none usable
  merge: boolean;                 // run every provider and merge, instead of first-that-works
  searxngUrl: string | null;
  searxngAllowHttp: boolean;
  maxResults: number;
  allowedRoles: string[] | null;  // null = every role that may use Buddy
};

export const WEB_DEFAULTS = Object.freeze({
  MAX_RESULTS: 6,
  SEARCH_TIMEOUT_MS: 15_000,
  FETCH_TIMEOUT_MS: 20_000,
  PAGE_CHAR_CAP: 12_000,          // what one page contributes to the prompt
  SNIPPET_CHAR_CAP: 700,
  MAX_BODY_BYTES: 2_000_000,      // how much of a response we will even read
});

// Read a response body up to `max` bytes and stop pulling. Falls back to
// res.text() where the body is not a stream (some fetch stubs).
export async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader?.();
  if (!reader) return (await res.text()).slice(0, max);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
        if (total >= max) break;
      }
    }
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
  const buf = new Uint8Array(Math.min(total, max));
  let at = 0;
  for (const c of chunks) {
    if (at >= buf.length) break;
    const take = Math.min(c.byteLength, buf.length - at);
    buf.set(c.subarray(0, take), at);
    at += take;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(buf);
}

export function webConfig(row: Record<string, unknown> | null | undefined): WebConfig {
  const r = row ?? {};
  // De-duplicated: a repeated provider would be queried (and billed) twice in
  // merge mode.
  const rawProviders = Array.isArray(r.web_providers)
    ? [...new Set((r.web_providers as unknown[]).filter(isWebProvider))]
    : null;
  const url = typeof r.searxng_url === 'string' && r.searxng_url.trim() ? r.searxng_url.trim() : null;
  const n = Number(r.web_max_results);
  return {
    enabled: r.web_search_enabled === true,
    providers: rawProviders?.length ? rawProviders : ['searxng', 'tavily'],
    merge: (r as any).web_merge === true,
    searxngUrl: url,
    searxngAllowHttp: (r as any).searxng_allow_http === true,
    // Math.max(1, …) because floor(0.5) is 0, which would ask for no results.
    maxResults: Number.isFinite(n) && n > 0 ? Math.min(20, Math.max(1, Math.floor(n))) : WEB_DEFAULTS.MAX_RESULTS,
    allowedRoles: Array.isArray(r.web_allowed_roles) ? (r.web_allowed_roles as unknown[]).map((x) => String(x).toLowerCase()) : null,
  };
}

export const webAllowedForRole = (cfg: WebConfig, role: string): boolean =>
  cfg.enabled && (!cfg.allowedRoles || cfg.allowedRoles.includes(String(role).toLowerCase()));

export type WebKeys = { tavily?: string | null };

export type WebEnv = {
  config: WebConfig;
  keys: WebKeys;
  fetchImpl?: typeof fetch;
};

// Same page from two engines → one hit. Compared without the scheme, a
// leading www., a trailing slash or tracking parameters, so the duplicate that
// differs only by utm_source collapses too.
export function canonicalUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = '';
    // Prefix match, not an exact one: mc_cid / mc_eid / utm_anything.
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm|mc|ga|hsa|pk|piwik|at|yclid|msclkid)_/i.test(k) || /^(fbclid|gclid|dclid|gbraid|wbraid|igshid|si|ref|ref_src|source|spm|scm)$/i.test(k)) u.searchParams.delete(k);
    }
    u.searchParams.sort();                         // ?a=1&b=2 == ?b=2&a=1
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    // The port is part of identity: example.com:8443 is not example.com.
    const port = u.port && !((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) ? `:${u.port}` : '';
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return `${host}${port}${path}${u.search}`;
  } catch { return String(raw).trim().toLowerCase(); }
}

export function mergeHits(lists: WebHit[][], max: number): WebHit[] {
  if (!Number.isFinite(max) || max <= 0) return [];
  const seen = new Map<string, WebHit>();
  // Interleave the providers so the first one does not fill the whole budget.
  const depth = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < depth; i++) {
    for (const list of lists) {
      const h = list[i];
      if (!h) continue;
      const k = canonicalUrl(h.url);
      const prev = seen.get(k);
      if (!prev) seen.set(k, h);
      else if (!prev.snippet && h.snippet) seen.set(k, { ...prev, snippet: h.snippet, engine: `${prev.engine}+${h.engine}` });
      else if (prev.engine !== h.engine) seen.set(k, { ...prev, engine: `${prev.engine}+${h.engine}` });
      if (seen.size >= max) return [...seen.values()];
    }
  }
  return [...seen.values()];
}

// Which providers can actually run right now, in the configured order.
export function usableProviders(env: WebEnv): WebProvider[] {
  return env.config.providers.filter((p) => (p === 'searxng' ? !!env.config.searxngUrl : !!env.keys.tavily));
}

export async function webSearch(env: WebEnv, a: {
  query: string; maxResults?: number; timeRange?: 'day' | 'week' | 'month' | 'year' | null;
  topic?: 'general' | 'news' | 'finance'; includeDomains?: string[]; excludeDomains?: string[];
}): Promise<WebSearchOutcome> {
  const cfg = env.config;
  const max = Math.min(a.maxResults ?? cfg.maxResults, 20);
  const usage: WebUsage[] = [];
  const errors: { provider: string; error: string }[] = [];
  const providersTried: string[] = [];
  const lists: WebHit[][] = [];
  let answer: string | null = null;

  const providers = usableProviders(env);
  if (!providers.length) {
    return { hits: [], answer: null, usage, providersTried, errors: [{ provider: 'none', error: 'no web search provider is configured' }] };
  }

  const runOne = async (p: WebProvider): Promise<WebHit[]> => {
    providersTried.push(p);
    if (p === 'searxng') {
      const r = await searxngSearch({
        query: a.query, maxResults: max,
        categories: a.topic === 'news' ? 'news' : 'general',
        // SearXNG has no 'week': the nearest wider window is a month.
        timeRange: a.timeRange === 'week' ? 'month' : (a.timeRange as 'day' | 'month' | 'year' | null | undefined) ?? null,
      }, { baseUrl: cfg.searxngUrl!, fetchImpl: env.fetchImpl, timeoutMs: WEB_DEFAULTS.SEARCH_TIMEOUT_MS, allowHttp: cfg.searxngAllowHttp });
      usage.push({ provider: 'searxng', calls: 1, credits: 0 });
      return r.hits;
    }
    const r = await tavilySearch({
      query: a.query, maxResults: max, topic: a.topic ?? 'general',
      timeRange: a.timeRange ?? null, includeDomains: a.includeDomains, excludeDomains: a.excludeDomains,
    }, { apiKey: env.keys.tavily!, fetchImpl: env.fetchImpl, timeoutMs: WEB_DEFAULTS.SEARCH_TIMEOUT_MS });
    usage.push({ provider: 'tavily', calls: 1, credits: r.credits });
    if (r.answer && !answer) answer = r.answer;
    return r.hits;
  };

  for (const p of providers) {
    try {
      const hits = await runOne(p);
      if (hits.length) lists.push(hits);
      // First-that-works: stop as soon as one provider returned something.
      if (!cfg.merge && hits.length) break;
    } catch (e) {
      errors.push({ provider: p, error: describeProviderError(e) });
    }
  }
  return { hits: mergeHits(lists, max), answer, usage, providersTried, errors };
}

export function describeProviderError(e: unknown): string {
  if (e instanceof SearxngError) return [e.message, e.hint].filter(Boolean).join(' ');
  if (e instanceof TavilyError) {
    if (e.status === 401 || e.status === 403) return 'Tavily refused the API key.';
    if (e.status === 432 || e.status === 433 || /credit|quota|plan/i.test(e.message)) return 'The Tavily plan is out of credits.';
    if (e.status === 429) return 'Tavily is rate-limiting us.';
    return `Tavily error: ${e.message}`;
  }
  const m = String((e as Error)?.message ?? e);
  return /timed out|timeout|aborted/i.test(m) ? 'the provider did not answer in time' : m.slice(0, 200);
}

// ── reading one page ────────────────────────────────────────────────────────
// Tavily's extractor first (it handles JS-rendered pages and gives markdown);
// a plain guarded fetch is the fallback, so a configured-SearXNG-only install
// can still browse.
export async function webFetchPage(env: WebEnv, url: string, o: { query?: string; charCap?: number } = {}):
  Promise<{ page: WebPage | null; usage: WebUsage[]; error: string | null }> {
  const cap = o.charCap ?? WEB_DEFAULTS.PAGE_CHAR_CAP;
  const usage: WebUsage[] = [];
  const problems: string[] = [];

  // Guard BEFORE the URL leaves the building. Tavily fetches from its own side,
  // so a bad URL there is not an SSRF against us — but handing a paid third
  // party a file:// URL, a credentialed URL or an internal address spends
  // credits and leaks whatever is in it. QA caught this ordering.
  const g = checkUrl(url);
  if (!g.ok) return { page: null, usage, error: `refused to fetch that URL: ${g.reason}` };

  if (env.keys.tavily) {
    try {
      const r = await tavilyExtract([url], { apiKey: env.keys.tavily, fetchImpl: env.fetchImpl, timeoutMs: WEB_DEFAULTS.FETCH_TIMEOUT_MS, ...(o.query ? { query: o.query } : {}) });
      usage.push({ provider: 'tavily', calls: 1, credits: r.credits });
      const p = r.pages[0];
      if (p?.text) return { page: { ...p, text: p.text.slice(0, cap) }, usage, error: null };
      if (r.failed[0]) problems.push(`Tavily could not read it (${r.failed[0].error})`);
    } catch (e) { problems.push(describeProviderError(e)); }
  }

  try {
    const { res, url: finalUrl } = await safeFetch(url, {
      headers: { accept: 'text/html,application/xhtml+xml,text/plain;q=0.9', 'user-agent': 'WurxOS-Buddy/1.0 (+https://wurxmedia.com)' },
      fetchImpl: env.fetchImpl,
      signal: AbortSignal.timeout(WEB_DEFAULTS.FETCH_TIMEOUT_MS),
    });
    if (!res.ok) { try { await res.body?.cancel(); } catch { /* drained */ } problems.push(`the page returned HTTP ${res.status}`); return { page: null, usage, error: problems.join('; ') }; }
    const type = (res.headers.get('content-type') ?? '').toLowerCase();
    if (!/text\/html|text\/plain|application\/xhtml|application\/json|text\/markdown/.test(type)) {
      try { await res.body?.cancel(); } catch { /* drained */ }
      problems.push(`that is not a readable page (content-type ${type.split(';')[0] || 'unknown'})`);
      return { page: null, usage, error: problems.join('; ') };
    }
    // Read at most MAX_BODY_BYTES, whatever Content-Length claims. Streamed and
    // stopped early: `await res.text()` buffers the WHOLE body first, so a
    // hostile multi-gigabyte page would be held in memory before any slice.
    const raw = await readCapped(res, WEB_DEFAULTS.MAX_BODY_BYTES);
    const { title, text } = /json|plain|markdown/.test(type) ? { title: null, text: raw } : htmlToText(raw);
    usage.push({ provider: 'direct', calls: 1, credits: 0 });
    if (!text.trim()) { problems.push('the page had no readable text'); return { page: null, usage, error: problems.join('; ') }; }
    return { page: { url: finalUrl, title, text: text.slice(0, cap), source: 'direct' }, usage, error: null };
  } catch (e) {
    problems.push(describeProviderError(e));
    return { page: null, usage, error: problems.join('; ') };
  }
}
