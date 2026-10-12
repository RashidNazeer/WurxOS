import { test } from 'node:test';
import assert from 'node:assert/strict';
import { braveSearch, BraveError, FRESHNESS } from '../web/brave.ts';
import { describeProviderError } from '../web/index.ts';

// Cost guard: any code path that reaches the real network fails the test loudly.
globalThis.fetch = (() => { throw new Error('REAL NETWORK ATTEMPTED - every brave test must inject fetchImpl'); }) as typeof fetch;

const KEY = 'BSA-test-key-do-not-leak-0123456789';
const ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

type Call = { url: string; init: RequestInit };
function stub(h: (url: string, init: RequestInit, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (input: any, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return h(String(input), init, calls.length - 1);
  }) as typeof fetch;
  return { fn, calls };
}
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const ok = (results: unknown) => json({ type: 'search', web: { type: 'search', results } });
const run = (s: ReturnType<typeof stub>, a: Parameters<typeof braveSearch>[0]) => braveSearch(a, { apiKey: KEY, fetchImpl: s.fn });
const qs = (c: Call) => new URL(c.url).searchParams;

// ------------------------------------------------------------------ request shape
test('brave: GET to the Web Search endpoint with the X-Subscription-Token header, not a bearer token', async () => {
  const s = stub(() => ok([]));
  await run(s, { query: 'tiktok shop fees' });
  assert.equal(s.calls.length, 1);
  const c = s.calls[0];
  assert.equal(c.init.method, 'GET');
  assert.ok(c.url.startsWith(`${ENDPOINT}?`), c.url);
  const h = new Headers(c.init.headers as HeadersInit);
  assert.equal(h.get('X-Subscription-Token'), KEY);
  assert.equal(h.get('authorization'), null, 'Brave does not use a bearer token');
  assert.equal(h.get('accept'), 'application/json');
  assert.equal(c.init.body, undefined);
});

test('brave: the key is never in the URL, and the query is encoded into q', async () => {
  const s = stub(() => ok([]));
  await run(s, { query: 'a&b=c d é中 ?#' });
  const c = s.calls[0];
  assert.ok(!c.url.includes(KEY), 'key in URL');
  assert.ok(!decodeURIComponent(c.url).includes(KEY));
  assert.equal(qs(c).get('q'), 'a&b=c d é中 ?#');
  assert.equal(qs(c).get('text_decorations'), 'false');
  assert.equal(qs(c).get('safesearch'), 'moderate');
  assert.equal(qs(c).get('count'), '6');
  assert.equal(qs(c).get('freshness'), null, 'no recency, no freshness');
  assert.equal(qs(c).get('country'), null);
});

test('brave: safesearch can be changed, and an unrecognised value is simply passed through to Brave to judge', async () => {
  const s = stub(() => ok([]));
  await run(s, { query: 'x', safesearch: 'strict' });
  assert.equal(qs(s.calls[0]).get('safesearch'), 'strict');
});

test('brave: unicode and very long queries are sent intact (the URL-encoded form is bounded only by Brave)', async () => {
  const s = stub(() => ok([]));
  const q = 'é中文😀 مرحبا'.repeat(100);
  await run(s, { query: q });
  assert.equal(qs(s.calls[0]).get('q'), q);
});

// ------------------------------------------------------------------ count / freshness / country
test('brave: count is clamped to 1..20 and defaults to 6', async () => {
  const cases: [number | undefined, string][] = [[undefined, '6'], [1, '1'], [5, '5'], [20, '20'], [21, '20'], [9999, '20'], [0, '1'], [-5, '1']];
  for (const [n, want] of cases) {
    const s = stub(() => ok([]));
    await run(s, { query: 'q', maxResults: n });
    assert.equal(qs(s.calls[0]).get('count'), want, `maxResults=${n}`);
  }
});

// Not reachable today (webConfig and runWeb both floor before calling), but braveSearch is exported
// and Brave answers 422 to a non-integer count. Documented as a gap, not a failure.
test('GAP: a fractional or NaN maxResults is sent to Brave as "7.5" / "NaN" instead of an integer', { todo: 'braveSearch should floor count; callers happen to do it today' }, async () => {
  for (const n of [7.5, NaN]) {
    const s = stub(() => ok([]));
    await run(s, { query: 'q', maxResults: n });
    assert.match(qs(s.calls[0]).get('count')!, /^\d+$/, `maxResults=${n}`);
  }
});

test('brave: freshness maps day/week/month/year to pd/pw/pm/py and is omitted without recency', async () => {
  assert.deepEqual(FRESHNESS, { day: 'pd', week: 'pw', month: 'pm', year: 'py' });
  for (const [r, want] of [['day', 'pd'], ['week', 'pw'], ['month', 'pm'], ['year', 'py']] as const) {
    const s = stub(() => ok([]));
    await run(s, { query: 'q', timeRange: r });
    assert.equal(qs(s.calls[0]).get('freshness'), want, r);
  }
  for (const r of [null, undefined, 'decade' as any, '' as any]) {
    const s = stub(() => ok([]));
    await run(s, { query: 'q', timeRange: r });
    assert.equal(qs(s.calls[0]).get('freshness'), null, `timeRange=${String(r)}`);
  }
});

test('brave: country is upper-cased and cut to 2 characters; empty is omitted', async () => {
  for (const [c, want] of [['pk', 'PK'], ['Us', 'US'], ['gbr', 'GB'], ['p', 'P']] as const) {
    const s = stub(() => ok([]));
    await run(s, { query: 'q', country: c });
    assert.equal(qs(s.calls[0]).get('country'), want, c);
  }
  for (const c of ['', null, undefined]) {
    const s = stub(() => ok([]));
    await run(s, { query: 'q', country: c });
    assert.equal(qs(s.calls[0]).get('country'), null, `country=${String(c)}`);
  }
});

// ------------------------------------------------------------------ response mapping
test('brave: results map title / url / description to a WebHit, score is null, engine is brave', async () => {
  const s = stub(() => ok([{ title: 'Fees', url: 'https://example.com/fees', description: 'All the fees.' }]));
  const { hits } = await run(s, { query: 'q' });
  assert.deepEqual(hits, [{ title: 'Fees', url: 'https://example.com/fees', snippet: 'All the fees.', publishedAt: null, score: null, engine: 'brave' }]);
});

test('brave: extra_snippets are appended to the description, joined by a space', async () => {
  const s = stub(() => ok([{ title: 't', url: 'https://e.com/', description: 'Main.', extra_snippets: ['Second.', 'Third.'] }]));
  const { hits } = await run(s, { query: 'q' });
  assert.equal(hits[0].snippet, 'Main. Second. Third.');
});

test('brave: extra_snippets alone still make a snippet; empty strings and a non-array extra_snippets are ignored', async () => {
  const s = stub(() => ok([
    { title: 'a', url: 'https://a.com/', extra_snippets: ['only extra'] },
    { title: 'b', url: 'https://b.com/', description: 'd', extra_snippets: 'not an array' },
    { title: 'c', url: 'https://c.com/', description: '', extra_snippets: ['', 'x'] },
  ]));
  const { hits } = await run(s, { query: 'q' });
  assert.deepEqual(hits.map((h) => h.snippet), ['only extra', 'd', 'x']);
});

test('brave: snippet is capped at 1200 chars and title at 300', async () => {
  const s = stub(() => ok([{ title: 'T'.repeat(1000), url: 'https://e.com/', description: 'd'.repeat(5000), extra_snippets: ['e'.repeat(5000)] }]));
  const { hits } = await run(s, { query: 'q' });
  assert.equal(hits[0].snippet.length, 1200);
  assert.equal(hits[0].title.length, 300);
});

test('brave: publishedAt prefers page_age, then age, then null', async () => {
  const s = stub(() => ok([
    { title: 'both', url: 'https://1.com/', description: 'd', page_age: '2026-10-01T08:00:00', age: '5 days ago' },
    { title: 'age only', url: 'https://2.com/', description: 'd', age: '5 days ago' },
    { title: 'page_age only', url: 'https://3.com/', description: 'd', page_age: '2026-09-01T00:00:00' },
    { title: 'neither', url: 'https://4.com/', description: 'd' },
    { title: 'empty page_age falls to age', url: 'https://5.com/', description: 'd', page_age: '', age: 'yesterday' },
    { title: 'null both', url: 'https://6.com/', description: 'd', page_age: null, age: null },
  ]));
  const { hits } = await run(s, { query: 'q' });
  assert.deepEqual(hits.map((h) => h.publishedAt), ['2026-10-01T08:00:00', '5 days ago', '2026-09-01T00:00:00', null, 'yesterday', null]);
  assert.ok(hits.every((h) => h.score === null));
});

test('brave: a title-less result falls back to its url; a url-less result is dropped; order is kept', async () => {
  const s = stub(() => ok([
    { url: 'https://a.com/', description: 'a' },
    { title: 'no url', description: 'x' },
    { title: 'c', url: 'https://c.com/', description: 'c' },
    null,
    'a string',
    42,
  ]));
  const { hits } = await run(s, { query: 'q' });
  assert.deepEqual(hits.map((h) => [h.title, h.url]), [['https://a.com/', 'https://a.com/'], ['c', 'https://c.com/']]);
});

test('brave: non-string fields are coerced, not thrown on', async () => {
  const s = stub(() => ok([{ title: 123, url: 'https://n.com/', description: { a: 1 }, extra_snippets: [1, null, 'z'] }]));
  const { hits } = await run(s, { query: 'q' });
  assert.equal(hits[0].title, '123');
  assert.equal(typeof hits[0].snippet, 'string');
});

// ------------------------------------------------------------------ malformed 200 bodies
test('brave: a missing web key, a null web, and a non-array results all read as "no results", never a TypeError', async () => {
  for (const body of [{}, { type: 'search' }, { web: null }, { web: {} }, { web: { results: null } }, { web: { results: {} } }, { web: { results: 'nope' } },
    { web: { results: 5 } }, { web: [] }, [], null, 'text', 7, true]) {
    const s = stub(() => json(body));
    const r = await run(s, { query: 'q' });
    assert.deepEqual(r, { hits: [] }, JSON.stringify(body));
  }
});

test('brave: other result groups (news, videos, infobox, discussions) are ignored; only web.results counts', async () => {
  const s = stub(() => json({ news: { results: [{ title: 'n', url: 'https://n.com/' }] }, videos: { results: [{ title: 'v', url: 'https://v.com/' }] }, web: { results: [{ title: 'w', url: 'https://w.com/', description: 'w' }] } }));
  const { hits } = await run(s, { query: 'q' });
  assert.deepEqual(hits.map((h) => h.url), ['https://w.com/']);
});

test('brave: a non-JSON 200 body is a clear BraveError, not a SyntaxError', async () => {
  for (const body of ['<html>captcha</html>', '', 'not json', '{"web":']) {
    const s = stub(() => new Response(body, { status: 200 }));
    await assert.rejects(run(s, { query: 'q' }), (e: any) => e instanceof BraveError && e.status === 200 && /non-JSON/.test(e.message), body);
  }
});

// ------------------------------------------------------------------ HTTP errors
test('brave: error statuses throw a BraveError carrying the status and Brave\'s detail', async () => {
  const s = stub(() => json({ error: { code: 'VALIDATION', detail: 'Unable to validate request parameter(s)', status: 422 } }, 422));
  await assert.rejects(run(s, { query: 'q' }), (e: any) => e instanceof BraveError && e.status === 422 && /Unable to validate/.test(e.message));
  const p = stub(() => json({ error: { code: 'RATE_LIMITED', meta: { plan: 'Free', rate_limit: 1 } } }, 429));
  await assert.rejects(run(p, { query: 'q' }), (e: any) => e.status === 429 && /Free/.test(e.message));
  const m = stub(() => json({ message: 'boom' }, 500));
  await assert.rejects(run(m, { query: 'q' }), (e: any) => e.status === 500 && e.message === 'boom');
  const t = stub(() => new Response('plain text failure', { status: 502 }));
  await assert.rejects(run(t, { query: 'q' }), (e: any) => e.status === 502 && e.message === 'plain text failure');
});

test('brave: an error body is capped at 300 chars', async () => {
  const s = stub(() => new Response('x'.repeat(10_000), { status: 500 }));
  await assert.rejects(run(s, { query: 'q' }), (e: any) => e.message.length === 300);
});

test('brave: an error body with no usable detail still produces a string, never "undefined" or an object', async () => {
  for (const body of [{}, { error: {} }, { error: { detail: { nested: true } } }, []]) {
    const s = stub(() => json(body, 500));
    await assert.rejects(run(s, { query: 'q' }), (e: any) => e instanceof BraveError && typeof e.message === 'string' && e.message !== 'undefined');
  }
});

// ------------------------------------------------------------------ describeProviderError
test('describeProviderError: 401 and 403 say the key was refused, and never contain the key', async () => {
  for (const status of [401, 403]) {
    // Worst case: the server echoes the token in its error body.
    const s = stub(() => json({ error: { detail: `Invalid subscription token ${KEY}` } }, status));
    const e = await run(s, { query: 'q' }).then(() => null, (x) => x);
    assert.ok(e instanceof BraveError && e.status === status);
    const text = describeProviderError(e);
    assert.equal(text, 'Brave refused the API key.');
    assert.ok(!text.includes(KEY));
  }
});

test('describeProviderError: 422 quotes the reason, 429 explains the free tier, anything else is a generic Brave error', () => {
  assert.equal(describeProviderError(new BraveError('bad count', 422)), 'Brave rejected the query: bad count');
  const rl = describeProviderError(new BraveError('slow down', 429));
  assert.match(rl, /rate-limiting/);
  assert.match(rl, /one request per second/);
  for (const st of [400, 404, 500, 502, 503, 200]) assert.equal(describeProviderError(new BraveError('oops', st)), 'Brave error: oops', String(st));
});

test('describeProviderError: a 422 or 5xx for a normal request carries no key', async () => {
  for (const status of [422, 500]) {
    const s = stub(() => json({ error: { detail: 'something went wrong' } }, status));
    const e = await run(s, { query: 'q' }).then(() => null, (x) => x);
    assert.ok(!describeProviderError(e).includes(KEY));
    assert.ok(!String(e.message).includes(KEY));
  }
});

// ------------------------------------------------------------------ guard
test('brave: goes through safeFetch, so a redirect to an internal address is refused and never fetched', async () => {
  const s = stub((url) => url.startsWith(ENDPOINT)
    ? new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } })
    : ok([{ title: 'leak', url: 'https://x.com/', description: 'should never be fetched' }]));
  await assert.rejects(run(s, { query: 'q' }), /refused to fetch a redirect/);
  assert.equal(s.calls.length, 1, 'the internal URL must not be requested');
});

test('brave: safeFetch does not follow into non-https schemes either', async () => {
  const s = stub(() => new Response(null, { status: 302, headers: { location: 'file:///etc/passwd' } }));
  await assert.rejects(run(s, { query: 'q' }), /refused to fetch a redirect/);
  assert.equal(s.calls.length, 1);
});

// A real finding: safeFetch re-sends the caller's headers on every hop, so the API key follows a
// redirect to ANOTHER host. The endpoint is a constant and Brave does not redirect today, so this is
// defence in depth only. Reported to the Lead; the fix is to drop auth headers when the origin changes.
test('GAP: the X-Subscription-Token header is forwarded when Brave redirects to a different public host', { todo: 'safeFetch forwards headers cross-origin' }, async () => {
  const seen: { url: string; token: string | null }[] = [];
  const s = stub((url, init) => {
    seen.push({ url, token: new Headers(init.headers as HeadersInit).get('x-subscription-token') });
    return url.startsWith(ENDPOINT) ? new Response(null, { status: 302, headers: { location: 'https://evil.example.org/collect' } }) : ok([]);
  });
  await run(s, { query: 'q' }).catch(() => {});
  const other = seen.find((c) => c.url.startsWith('https://evil.example.org/'));
  assert.ok(other, 'the redirect was followed (public host)');
  assert.equal(other!.token, null, 'the key must not be sent to a different origin');
});

test('brave: an already-aborted timeout surfaces as an error, not a hang', async () => {
  const s = stub((_u, init) => new Promise<Response>((_res, rej) => { (init.signal as AbortSignal).addEventListener('abort', () => rej(new Error('The operation was aborted due to timeout'))); }));
  await assert.rejects(braveSearch({ query: 'q' }, { apiKey: KEY, fetchImpl: s.fn, timeoutMs: 20 }), /timeout|aborted/i);
});
