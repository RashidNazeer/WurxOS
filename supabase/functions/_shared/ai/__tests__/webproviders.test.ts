import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROVIDER_ORDER, isWebProvider, providerReady, usableProviders, WEB_PROVIDERS, webConfig, webSearch } from '../web/index.ts';
import type { WebEnv } from '../web/index.ts';

// Cost guard: any code path that reaches the real network fails the test loudly.
globalThis.fetch = (() => { throw new Error('REAL NETWORK ATTEMPTED - every web test must inject fetchImpl'); }) as typeof fetch;

type Call = { url: string; init: RequestInit };
function stub(h: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (input: any, init: RequestInit = {}) => { const url = String(input); calls.push({ url, init }); return h(url, init); }) as typeof fetch;
  return { fn, calls };
}
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

const SX = 'https://search.example.com';
const isSx = (u: string) => u.startsWith(SX);
const isBrave = (u: string) => u.startsWith('https://api.search.brave.com/');
const isTavily = (u: string) => u.startsWith('https://api.tavily.com/');
const hit = (n: number | string, extra: Record<string, unknown> = {}) => ({ title: `t${n}`, url: `https://site${n}.com/p`, content: `c${n}`, ...extra });
const bhit = (n: number | string, extra: Record<string, unknown> = {}) => ({ title: `t${n}`, url: `https://site${n}.com/p`, description: `d${n}`, ...extra });
const sxBody = (...rs: unknown[]) => json({ results: rs });
const braveBody = (...rs: unknown[]) => json({ web: { results: rs } });
const tvBody = (rs: unknown[], credits = 1) => json({ results: rs, usage: { credits } });
const route = (o: { sx?: () => Response; brave?: () => Response; tv?: () => Response }) => stub((u) => {
  if (isSx(u)) return (o.sx ?? (() => sxBody()))();
  if (isBrave(u)) return (o.brave ?? (() => braveBody()))();
  if (isTavily(u)) return (o.tv ?? (() => tvBody([])))();
  throw new Error(`unexpected host ${u}`);
});
const envOf = (row: any, keys: any, f?: typeof fetch): WebEnv => ({ config: webConfig({ web_search_enabled: true, ...row }), keys, fetchImpl: f });
const hosts = (s: { calls: Call[] }) => s.calls.map((c) => (isSx(c.url) ? 'sx' : isBrave(c.url) ? 'brave' : isTavily(c.url) ? 'tavily' : '?'));
const ALL_KEYS = { tavily: 'tvly-k', brave: 'BSA-k' };

// ------------------------------------------------------------------ constants
test('providers: default order is searxng, brave, tavily; all three are valid names', () => {
  assert.deepEqual(DEFAULT_PROVIDER_ORDER, ['searxng', 'brave', 'tavily']);
  assert.deepEqual([...WEB_PROVIDERS].sort(), ['brave', 'searxng', 'tavily']);
  for (const p of ['searxng', 'brave', 'tavily']) assert.ok(isWebProvider(p));
  for (const p of ['Brave', 'bing', '', null, 5]) assert.ok(!isWebProvider(p));
  assert.deepEqual(webConfig({ web_providers: ['brave', 'tavily', 'searxng'] }).providers, ['brave', 'tavily', 'searxng']);
  assert.deepEqual(webConfig({ web_providers: ['brave', 'brave', 'brave'] }).providers, ['brave']);
});

test('providers: DEFAULT_PROVIDER_ORDER is not shared by reference (mutating one config cannot change the next)', () => {
  const a = webConfig({});
  a.providers.push('tavily');
  assert.deepEqual(webConfig({}).providers, ['searxng', 'brave', 'tavily']);
});

// ------------------------------------------------------------------ usableProviders / providerReady
test('usableProviders: Brave needs a key; blank, null, undefined and a missing key all mean "not usable"', () => {
  const sx = { searxng_url: SX };
  for (const brave of ['', null, undefined]) assert.deepEqual(usableProviders(envOf(sx, { brave })), ['searxng'], `brave=${String(brave)}`);
  assert.deepEqual(usableProviders(envOf(sx, {})), ['searxng']);
  assert.deepEqual(usableProviders(envOf({}, { brave: 'k' })), ['brave']);
  assert.deepEqual(usableProviders(envOf(sx, { brave: 'k' })), ['searxng', 'brave']);
  assert.deepEqual(usableProviders(envOf(sx, ALL_KEYS)), ['searxng', 'brave', 'tavily']);
});

test('usableProviders: honours the configured order and drops the unusable ones', () => {
  assert.deepEqual(usableProviders(envOf({ searxng_url: SX, web_providers: ['tavily', 'brave', 'searxng'] }, ALL_KEYS)), ['tavily', 'brave', 'searxng']);
  assert.deepEqual(usableProviders(envOf({ searxng_url: SX, web_providers: ['brave', 'tavily'] }, { brave: 'k' })), ['brave']);
  assert.deepEqual(usableProviders(envOf({ searxng_url: SX, web_providers: ['brave'] }, {})), []);
  assert.deepEqual(usableProviders(envOf({ searxng_url: SX, web_providers: ['tavily', 'brave'] }, { tavily: 'x' })), ['tavily']);
});

test('providerReady: an unknown provider name is never ready', () => {
  assert.equal(providerReady(envOf({ searxng_url: SX }, ALL_KEYS), 'bing' as any), false);
  assert.equal(providerReady(envOf({}, { brave: 'k' }), 'brave'), true);
  assert.equal(providerReady(envOf({}, { tavily: 'k' }), 'brave'), false);
});

// ------------------------------------------------------------------ Brave skipped without a key
test('webSearch: Brave has no key -> it sits out: no fetch to Brave, no error, no empty result set, not in providersTried', async () => {
  const s = route({ sx: () => sxBody(), tv: () => tvBody([hit(1)]) });
  const o = await webSearch(envOf({ searxng_url: SX }, { tavily: 'k' }, s.fn), { query: 'q' });
  assert.deepEqual(hosts(s), ['sx', 'tavily']);
  assert.deepEqual(o.providersTried, ['searxng', 'tavily']);
  assert.deepEqual(o.errors, [], 'a missing key is not an error');
  assert.deepEqual(o.hits.map((h) => h.url), ['https://site1.com/p']);
  assert.ok(!o.usage.some((u) => u.provider === 'brave'));
});

test('webSearch: Brave is the ONLY configured provider but has no key -> the clear "none configured" error, zero fetches', async () => {
  const s = route({});
  const o = await webSearch(envOf({ web_providers: ['brave'], searxng_url: SX }, { tavily: 'k' }, s.fn), { query: 'q' });
  assert.equal(s.calls.length, 0);
  assert.deepEqual(o.errors, [{ provider: 'none', error: 'no web search provider is configured' }]);
  assert.deepEqual(o.hits, []);
});

test('webSearch: Brave key added later (no other change) -> it starts being used', async () => {
  const withKey = route({ sx: () => sxBody(), brave: () => braveBody(bhit(1)) });
  const o = await webSearch(envOf({ searxng_url: SX }, { brave: 'k' }, withKey.fn), { query: 'q' });
  assert.deepEqual(o.providersTried, ['searxng', 'brave']);
  assert.equal(o.hits.length, 1);
});

// ------------------------------------------------------------------ first-that-works
test('webSearch (first-that-works): SearXNG empty -> Brave answers -> Tavily is never called', async () => {
  const s = route({ sx: () => sxBody(), brave: () => braveBody(bhit(1), bhit(2)), tv: () => tvBody([hit(9)]) });
  const o = await webSearch(envOf({ searxng_url: SX }, ALL_KEYS, s.fn), { query: 'q' });
  assert.deepEqual(hosts(s), ['sx', 'brave']);
  assert.deepEqual(o.providersTried, ['searxng', 'brave']);
  assert.deepEqual(o.hits.map((h) => h.engine), ['brave', 'brave']);
  assert.deepEqual(o.errors, []);
  assert.equal(o.answer, null);
});

test('webSearch (first-that-works): SearXNG has results -> neither Brave nor Tavily is called (no spend)', async () => {
  const s = route({ sx: () => sxBody(hit(1)) });
  const o = await webSearch(envOf({ searxng_url: SX }, ALL_KEYS, s.fn), { query: 'q' });
  assert.deepEqual(hosts(s), ['sx']);
  assert.deepEqual(o.usage, [{ provider: 'searxng', calls: 1, credits: 0 }]);
});

test('webSearch (first-that-works): Brave fails (429) -> the error is recorded and Tavily is tried next', async () => {
  const s = route({ sx: () => sxBody(), brave: () => json({ error: { code: 'RATE_LIMITED' } }, 429), tv: () => tvBody([hit(5)]) });
  const o = await webSearch(envOf({ searxng_url: SX }, ALL_KEYS, s.fn), { query: 'q' });
  assert.deepEqual(hosts(s), ['sx', 'brave', 'tavily']);
  assert.equal(o.errors.length, 1);
  assert.equal(o.errors[0].provider, 'brave');
  assert.match(o.errors[0].error, /rate-limiting/);
  assert.deepEqual(o.hits.map((h) => h.engine), ['tavily']);
});

test('webSearch: Brave answering with a malformed body is recorded as an error and does not stop the others', async () => {
  const s = route({ sx: () => sxBody(), brave: () => new Response('<html>', { status: 200 }), tv: () => tvBody([hit(5)]) });
  const o = await webSearch(envOf({ searxng_url: SX }, ALL_KEYS, s.fn), { query: 'q' });
  assert.equal(o.errors[0].provider, 'brave');
  assert.match(o.errors[0].error, /non-JSON/);
  assert.equal(o.hits.length, 1);
});

test('webSearch: Brave refusing the key reports a clear message and never echoes the key', async () => {
  const s = route({ sx: () => sxBody(), brave: () => json({ error: { detail: 'bad token BSA-k' } }, 401) });
  const o = await webSearch(envOf({ searxng_url: SX, web_providers: ['searxng', 'brave'] }, { brave: 'BSA-k' }, s.fn), { query: 'q' });
  assert.deepEqual(o.errors, [{ provider: 'brave', error: 'Brave refused the API key.' }]);
  assert.ok(!JSON.stringify(o).includes('BSA-k'));
});

test('webSearch: the configured order is followed (Brave first when asked)', async () => {
  const s = route({ brave: () => braveBody(bhit(1)), sx: () => sxBody(hit(2)) });
  const o = await webSearch(envOf({ searxng_url: SX, web_providers: ['brave', 'searxng', 'tavily'] }, ALL_KEYS, s.fn), { query: 'q' });
  assert.deepEqual(hosts(s), ['brave']);
  assert.deepEqual(o.providersTried, ['brave']);
});

// ------------------------------------------------------------------ usage
test('webSearch: usage reports { provider: "brave", calls: 1, credits: 0 }', async () => {
  const s = route({ sx: () => sxBody(), brave: () => braveBody(bhit(1)) });
  const o = await webSearch(envOf({ searxng_url: SX }, ALL_KEYS, s.fn), { query: 'q' });
  assert.deepEqual(o.usage, [{ provider: 'searxng', calls: 1, credits: 0 }, { provider: 'brave', calls: 1, credits: 0 }]);
});

test('webSearch: a FAILED Brave call adds no usage row (only calls that returned are counted)', async () => {
  const s = route({ sx: () => sxBody(), brave: () => json({}, 500 ), tv: () => tvBody([hit(1)], 2) });
  const o = await webSearch(envOf({ searxng_url: SX }, ALL_KEYS, s.fn), { query: 'q' });
  assert.deepEqual(o.usage, [{ provider: 'searxng', calls: 1, credits: 0 }, { provider: 'tavily', calls: 1, credits: 2 }]);
});

// ------------------------------------------------------------------ request details through webSearch
test('webSearch: Brave gets its key in X-Subscription-Token only, the recency as freshness, and the result cap as count', async () => {
  const s = route({ brave: () => braveBody(bhit(1)) });
  await webSearch(envOf({ web_providers: ['brave'] }, { brave: 'BSA-k' }, s.fn), { query: 'what is new', maxResults: 3, timeRange: 'week' });
  const c = s.calls[0];
  const u = new URL(c.url);
  assert.equal(u.searchParams.get('freshness'), 'pw');
  assert.equal(u.searchParams.get('count'), '3');
  assert.equal(u.searchParams.get('q'), 'what is new');
  assert.equal(new Headers(c.init.headers as HeadersInit).get('x-subscription-token'), 'BSA-k');
  assert.ok(!c.url.includes('BSA-k'));
});

test('webSearch: the Brave key is not sent to SearXNG or Tavily, and their keys are not sent to Brave', async () => {
  const s = route({ sx: () => sxBody(), brave: () => braveBody(), tv: () => tvBody([hit(1)]) });
  await webSearch(envOf({ searxng_url: SX }, { brave: 'BSA-secret', tavily: 'tvly-secret' }, s.fn), { query: 'q' });
  for (const c of s.calls) {
    const blob = JSON.stringify([c.url, c.init.headers, c.init.body]);
    if (isBrave(c.url)) assert.ok(!blob.includes('tvly-secret'), 'tavily key sent to brave');
    else assert.ok(!blob.includes('BSA-secret'), `brave key sent to ${c.url}`);
  }
});

test('webSearch: every Brave request is a GET with no body, whatever the query', async () => {
  const s = route({ brave: () => braveBody() });
  await webSearch(envOf({ web_providers: ['brave'] }, { brave: 'k' }, s.fn), { query: 'x'.repeat(3000) + ' é中😀' });
  assert.equal(s.calls[0].init.method, 'GET');
  assert.equal(s.calls[0].init.body, undefined);
});

// ------------------------------------------------------------------ merge mode
test('webSearch (merge): all three are queried, results interleave one by one across providers, duplicates collapse', async () => {
  const s = route({
    sx: () => sxBody(hit('a'), hit('b'), hit('c')),
    brave: () => braveBody(bhit('d'), bhit('e')),
    tv: () => tvBody([hit('f'), hit('g')]),
  });
  const o = await webSearch(envOf({ searxng_url: SX, web_merge: true }, ALL_KEYS, s.fn), { query: 'q', maxResults: 20 });
  assert.deepEqual(hosts(s), ['sx', 'brave', 'tavily']);
  assert.deepEqual(o.providersTried, ['searxng', 'brave', 'tavily']);
  // depth 0: a, d, f   depth 1: b, e, g   depth 2: c
  assert.deepEqual(o.hits.map((h) => h.title), ['ta', 'td', 'tf', 'tb', 'te', 'tg', 'tc']);
  assert.deepEqual(o.usage.map((u) => u.provider), ['searxng', 'brave', 'tavily']);
});

test('webSearch (merge): the same page from several providers is one hit, tracking params and www ignored, engines combined', async () => {
  const s = route({
    sx: () => sxBody({ title: 'Fees', url: 'https://www.example.com/fees/?utm_source=x', content: 'sx text', engine: 'google' }),
    brave: () => braveBody({ title: 'Fees', url: 'https://example.com/fees', description: 'brave text' }),
    tv: () => tvBody([{ title: 'Fees', url: 'http://example.com/fees#top', content: 'tv text' }, hit('other')]),
  });
  const o = await webSearch(envOf({ searxng_url: SX, web_merge: true }, ALL_KEYS, s.fn), { query: 'q' });
  assert.equal(o.hits.length, 2);
  assert.equal(o.hits[0].url, 'https://www.example.com/fees/?utm_source=x', 'the first provider\'s copy wins');
  assert.match(o.hits[0].engine, /^searxng:google\+brave/);
  assert.equal(o.hits[1].title, 'tother');
});

test('webSearch (merge): the result cap applies across the merged list', async () => {
  const s = route({ sx: () => sxBody(hit(1), hit(2), hit(3)), brave: () => braveBody(bhit(4), bhit(5), bhit(6)), tv: () => tvBody([hit(7), hit(8), hit(9)]) });
  const o = await webSearch(envOf({ searxng_url: SX, web_merge: true }, ALL_KEYS, s.fn), { query: 'q', maxResults: 4 });
  assert.equal(o.hits.length, 4);
  assert.deepEqual(o.hits.map((h) => h.title), ['t1', 't4', 't7', 't2']);
});

test('webSearch (merge): one provider failing, or Brave being keyless, still returns the rest', async () => {
  const failing = route({ sx: () => sxBody(hit(1)), brave: () => json({}, 500), tv: () => tvBody([hit(2)]) });
  const o = await webSearch(envOf({ searxng_url: SX, web_merge: true }, ALL_KEYS, failing.fn), { query: 'q' });
  assert.deepEqual(o.hits.map((h) => h.title), ['t1', 't2']);
  assert.deepEqual(o.errors.map((e) => e.provider), ['brave']);

  const keyless = route({ sx: () => sxBody(hit(1)), tv: () => tvBody([hit(2)]) });
  const o2 = await webSearch(envOf({ searxng_url: SX, web_merge: true }, { tavily: 'k' }, keyless.fn), { query: 'q' });
  assert.deepEqual(hosts(keyless), ['sx', 'tavily']);
  assert.deepEqual(o2.errors, []);
  assert.equal(o2.hits.length, 2);
});

test('webSearch (merge): all three empty -> no hits and NO errors (empty is not a failure)', async () => {
  const s = route({});
  const o = await webSearch(envOf({ searxng_url: SX, web_merge: true }, ALL_KEYS, s.fn), { query: 'q' });
  assert.deepEqual(o.hits, []);
  assert.deepEqual(o.errors, []);
  assert.equal(o.usage.length, 3);
});

test('webSearch (merge): Tavily\'s answer is kept when Tavily is not the first provider', async () => {
  const s = route({ sx: () => sxBody(hit(1)), brave: () => braveBody(bhit(2)), tv: () => json({ results: [hit(3)], answer: 'the answer', usage: { credits: 1 } }) });
  const o = await webSearch(envOf({ searxng_url: SX, web_merge: true }, ALL_KEYS, s.fn), { query: 'q' });
  assert.equal(o.answer, 'the answer');
});

test('webSearch (merge): Brave publishedAt and score survive the merge', async () => {
  const s = route({ brave: () => braveBody(bhit(1, { page_age: '2026-10-01T00:00:00', age: '1 day ago' })) });
  const o = await webSearch(envOf({ web_providers: ['brave'], web_merge: true }, { brave: 'k' }, s.fn), { query: 'q' });
  assert.equal(o.hits[0].publishedAt, '2026-10-01T00:00:00');
  assert.equal(o.hits[0].score, null);
});
