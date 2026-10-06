import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkUrl, embeddedPrivateIp, ipv4Octets, ipv6Bytes, isPrivateIpv4, isPrivateIpv6, MAX_REDIRECTS, resolvesPublic, safeFetch } from '../web/guard.ts';
import { searxngSearch, SearxngError } from '../web/searxng.ts';
import { tavilyExtract, tavilySearch, TavilyError } from '../web/tavily.ts';
import { cutComments, cutElements, decodeEntities, htmlToText, MAX_HTML_CHARS } from '../web/html.ts';
import {
  canonicalUrl, describeProviderError, mergeHits, readCapped, usableProviders, WEB_DEFAULTS, webAllowedForRole, webConfig, webFetchPage, webSearch,
} from '../web/index.ts';
import type { WebEnv } from '../web/index.ts';
import type { WebHit } from '../web/types.ts';

// Cost guard: any code path that reaches the real network fails the test loudly.
globalThis.fetch = (() => { throw new Error('REAL NETWORK ATTEMPTED - every web test must inject fetchImpl'); }) as typeof fetch;

type Call = { url: string; init: RequestInit };
type Handler = (url: string, init: RequestInit, n: number) => Response | Promise<Response>;
function stub(h: Handler) {
  const calls: Call[] = [];
  const fn = (async (input: any, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return h(url, init, calls.length - 1);
  }) as typeof fetch;
  return { fn, calls };
}
const html = (body: string, status = 200, type = 'text/html; charset=utf-8') => new Response(body, { status, headers: { 'content-type': type } });
const redirect = (to: string, status = 302) => new Response(null, { status, headers: { location: to } });
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

const rejected = (u: string, o?: { allowHttp?: boolean; allowPrivate?: boolean }) => assert.equal(checkUrl(u, o).ok, false, `must REJECT ${u}`);
const accepted = (u: string, o?: { allowHttp?: boolean; allowPrivate?: boolean }) => assert.equal(checkUrl(u, o).ok, true, `must ACCEPT ${u} (${JSON.stringify(checkUrl(u, o))})`);

// ------------------------------------------------------------------ checkUrl: rejections
test('checkUrl: non-http(s) schemes are rejected', () => {
  for (const u of ['file:///etc/passwd', 'gopher://example.com/', 'data:text/html,hi', 'javascript:alert(1)', 'ftp://example.com/', 'ws://example.com/', 'blob:https://example.com/x', 'not a url', '', '//example.com/']) rejected(u, { allowHttp: true });
});

test('checkUrl: plain http only with allowHttp', () => {
  rejected('http://example.com/');
  rejected('http://example.com/', {});
  rejected('http://example.com/', { allowHttp: false });
  accepted('http://example.com/', { allowHttp: true });
  accepted('https://example.com/');
});

test('checkUrl: credentials in the URL are rejected', () => {
  for (const u of ['https://user:pass@example.com/', 'https://user@example.com/', 'https://:pass@example.com/', 'https://a%40b:c@example.com/']) rejected(u);
});

test('checkUrl: localhost and dotless hosts', () => {
  for (const u of ['https://localhost/', 'https://LOCALHOST/', 'https://localhost./', 'https://localhost:8443/x', 'https://intranet/', 'https://db/', 'https://printer/', 'https://kubernetes/', 'https://a.localhost/'])
    rejected(u, { allowHttp: true });
});

test('checkUrl: blocked internal suffixes and cloud metadata hosts', () => {
  for (const u of [
    'https://printer.local/', 'https://svc.internal/', 'https://router.home.arpa/', 'https://api.default.svc/', 'https://api.default.svc.cluster.local/',
    'https://nas.lan/', 'https://wiki.intranet/', 'https://x.corp/', 'https://metadata.google.internal/', 'https://metadata.google.internal./computeMetadata/v1/',
    'https://instance-data/', 'https://instance-data.ec2.internal/latest/meta-data/', 'https://metadata.goog/', 'https://METADATA.GOOGLE.INTERNAL/',
  ]) rejected(u, { allowHttp: true });
  // a public name that merely CONTAINS a blocked word must still work
  accepted('https://notlocal.com/');
  accepted('https://internal-tools.example.com/');
  accepted('https://example.com/local/internal');
});

test('checkUrl: loopback, 0.0.0.0, link-local / cloud metadata IP', () => {
  for (const u of ['http://127.0.0.1/', 'http://127.1.2.3/', 'http://127.255.255.254/', 'http://0.0.0.0/', 'http://0.1.2.3/', 'http://169.254.169.254/', 'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    'http://169.254.0.1/', 'http://169.254.255.255/', 'http://127.0.0.1:54321/', 'http://127.0.0.1./'])
    rejected(u, { allowHttp: true });
  rejected('https://169.254.169.254/latest/meta-data/');
  assert.match((checkUrl('http://169.254.169.254/', { allowHttp: true }) as any).reason, /private/);
});

test('checkUrl: RFC1918, carrier NAT, benchmarking, multicast/reserved', () => {
  const bad = [
    '10.0.0.1', '10.255.255.255', '192.168.0.1', '192.168.255.255', '172.16.0.1', '172.20.5.5', '172.31.255.255',
    '100.64.0.1', '100.127.255.255', '198.18.0.1', '198.19.255.255', '192.0.0.1', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
  ];
  for (const ip of bad) { rejected(`https://${ip}/`); rejected(`http://${ip}:8080/x`, { allowHttp: true }); }
});

test('checkUrl: IPv6 loopback, unspecified, link-local, unique-local, v4-mapped', () => {
  for (const u of [
    'https://[::1]/', 'https://[::]/', 'https://[0:0:0:0:0:0:0:1]/', 'https://[fe80::1]/', 'https://[fe80::1%25eth0]/', 'https://[febf::1]/', 'https://[fc00::1]/', 'https://[fd00::1]/',
    'https://[fdff:ffff::1]/', 'https://[::ffff:127.0.0.1]/', 'https://[::ffff:7f00:1]/', 'https://[::ffff:169.254.169.254]/', 'https://[::ffff:10.0.0.1]/', 'https://[::ffff:192.168.1.1]/',
    'https://[::1]:8443/',
  ]) rejected(u, { allowHttp: true });
});

test('checkUrl: obfuscated IPv4 spellings never slip through', () => {
  // ipv4Octets itself refuses to interpret them ...
  assert.equal(ipv4Octets('0177.0.0.1'), null);
  assert.equal(ipv4Octets('2130706433'), null);
  assert.equal(ipv4Octets('0x7f.0.0.1'), null);
  assert.equal(ipv4Octets('127.1'), null);
  assert.equal(ipv4Octets('1.2.3'), null);
  assert.equal(ipv4Octets('1.2.3.4.5'), null);
  assert.equal(ipv4Octets('256.1.1.1'), null);
  assert.equal(ipv4Octets('01.2.3.4'), null);
  assert.deepEqual(ipv4Octets('127.0.0.1'), [127, 0, 0, 1]);
  assert.deepEqual(ipv4Octets('0.0.0.0'), [0, 0, 0, 0]);
  // ... and in any case the overall verdict is a rejection, however it is written.
  for (const u of [
    'http://0177.0.0.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://0x7f.0.0.1/', 'http://127.1/', 'http://017700000001/', 'http://0/', 'http://0x0/',
    'http://2852039166/',               // 169.254.169.254 as an integer
    'http://0xA9FEA9FE/',               // 169.254.169.254 as hex
    'http://0251.0376.0251.0376/',      // 169.254.169.254 as octal
    'http://169.254.43518/',            // 169.254.169.254 mixed
    'http://%31%32%37.0.0.1/',          // percent-encoded host
    'http://127。 0。0。1/'.replace(' ', ''), // ideographic full stop
    'http://１２７.0.0.1/', // fullwidth digits
    'http://167772161/',                // 10.0.0.1
    'http://3232235521/',               // 192.168.0.1
  ]) rejected(u, { allowHttp: true });
});

test('checkUrl: URL parser tricks that would confuse the host', () => {
  // The host is whatever WHATWG URL says, and that is what safeFetch then fetches.
  const g = checkUrl('https://example.com\\@127.0.0.1/', {});
  if (g.ok) assert.equal(g.url.hostname, 'example.com');   // backslash ends the authority, so the host is example.com, and is public
  rejected('https://127.0.0.1\\@example.com/');             // host is 127.0.0.1
  rejected('https://example.com@127.0.0.1/');               // credentials
  rejected('  http://127.0.0.1/  ', { allowHttp: true });   // whitespace is trimmed, not a bypass
  rejected('http://127.0.0.1#@example.com/', { allowHttp: true });
  rejected('http://127.0.0.1?@example.com/', { allowHttp: true });
});

// ------------------------------------------------------------------ checkUrl: acceptances
test('checkUrl: ordinary public URLs are accepted', () => {
  for (const u of [
    'https://example.com/', 'https://www.example.co.uk/a/b?c=d#e', 'https://example.com:8443/path/to/page.html?x=1&y=2',
    'https://172.32.0.1/', 'https://172.15.255.255/', 'https://11.0.0.1/', 'https://8.8.8.8/', 'https://1.1.1.1/', 'https://100.63.255.255/', 'https://100.128.0.1/',
    'https://198.17.0.1/', 'https://198.20.0.1/', 'https://169.253.1.1/', 'https://169.255.1.1/', 'https://192.169.0.1/', 'https://192.167.0.1/',
    'https://223.255.255.255/', 'https://xn--bcher-kva.example/', 'https://bücher.example/', 'https://sub.domain.example.com./',
    'https://[2606:4700:4700::1111]/',
  ]) accepted(u);
  const g = checkUrl('https://Example.COM:8443/Path?q=1') as any;
  assert.equal(g.url.toString(), 'https://example.com:8443/Path?q=1');
});

test('isPrivateIpv4 / isPrivateIpv6 boundaries', () => {
  assert.equal(isPrivateIpv4([172, 15, 0, 0]), false);
  assert.equal(isPrivateIpv4([172, 16, 0, 0]), true);
  assert.equal(isPrivateIpv4([172, 31, 255, 255]), true);
  assert.equal(isPrivateIpv4([172, 32, 0, 0]), false);
  assert.equal(isPrivateIpv4([100, 63, 0, 0]), false);
  assert.equal(isPrivateIpv4([100, 64, 0, 0]), true);
  assert.equal(isPrivateIpv4([100, 127, 0, 0]), true);
  assert.equal(isPrivateIpv4([100, 128, 0, 0]), false);
  assert.equal(isPrivateIpv4([223, 255, 255, 255]), false);
  assert.equal(isPrivateIpv4([224, 0, 0, 0]), true);
  assert.equal(isPrivateIpv6('[::1]'), true);
  assert.equal(isPrivateIpv6('2606:4700:4700::1111'), false);
  assert.equal(isPrivateIpv6('::ffff:8.8.8.8'), false);
  assert.equal(isPrivateIpv6('::ffff:127.0.0.1'), true);
});

// ------------------------------------------------------------------ former gaps, now hard assertions (fixed after the first QA pass)
test('GAP: a public-looking hostname that resolves to a private IP (DNS rebinding / nip.io) is accepted', () => {
  rejected('https://169.254.169.254.nip.io/latest/meta-data/');
  rejected('https://localtest.me/');
  rejected('https://127.0.0.1.sslip.io/');
});

test('GAP: IPv4-compatible / NAT64 / 6to4 IPv6 forms of private addresses are accepted', () => {
  rejected('https://[::7f00:1]/');            // ::127.0.0.1 (IPv4-compatible)
  rejected('https://[64:ff9b::a9fe:a9fe]/');  // NAT64 of 169.254.169.254
  rejected('https://[2002:a9fe:a9fe::1]/');   // 6to4 of 169.254.169.254
  rejected('https://[ff02::1]/');             // IPv6 multicast
});

test('GAP: non-standard ports on public hosts are allowed', () => {
  rejected('https://example.com:22/');
  rejected('https://example.com:6379/');
});

// ------------------------------------------------------------------ safeFetch
test('safeFetch: public URL that 302s to the metadata service is refused and the metadata host is never fetched', async () => {
  const s = stub((u) => (u.startsWith('https://example.com/') ? redirect('http://169.254.169.254/latest/meta-data/') : html('SECRET-CREDS')));
  await assert.rejects(() => safeFetch('https://example.com/start', { fetchImpl: s.fn, allowHttp: true }), /refused to fetch a redirect: that address is private/);
  assert.equal(s.calls.length, 1);
  assert.ok(s.calls.every((c) => !c.url.includes('169.254')), 'metadata host must never be requested');
});

test('safeFetch: redirect to every private flavour is blocked (relative, protocol-relative, https->http, obfuscated, IPv6, localhost)', async () => {
  for (const target of [
    'http://127.0.0.1:54321/', 'https://localhost/admin', 'https://[::1]/', 'https://10.0.0.5/', 'http://0177.0.0.1/', 'http://2130706433/', '//169.254.169.254/x',
    'https://metadata.google.internal/', 'file:///etc/passwd', 'gopher://x.example/', 'http://example.com/downgrade',
  ]) {
    const s = stub((u) => (u === 'https://example.com/a' ? redirect(target) : html('LEAK')));
    await assert.rejects(() => safeFetch('https://example.com/a', { fetchImpl: s.fn }), /refused/, target);
    assert.equal(s.calls.length, 1, `second hop must not be fetched for ${target}`);
  }
});

test('safeFetch: allowHttp false also blocks an https->http downgrade redirect; allowHttp true permits it', async () => {
  const mk = () => stub((u) => (u === 'https://example.com/a' ? redirect('http://example.org/b') : html('ok')));
  let s = mk();
  await assert.rejects(() => safeFetch('https://example.com/a', { fetchImpl: s.fn }), /only https/);
  s = mk();
  const r = await safeFetch('https://example.com/a', { fetchImpl: s.fn, allowHttp: true });
  assert.equal(r.url, 'http://example.org/b');
});

test('safeFetch: the initial URL is checked too, before any fetch', async () => {
  const s = stub(() => html('x'));
  await assert.rejects(() => safeFetch('http://169.254.169.254/', { fetchImpl: s.fn, allowHttp: true }), /refused to fetch that URL/);
  await assert.rejects(() => safeFetch('https://user:p@example.com/', { fetchImpl: s.fn }), /credentials/);
  assert.equal(s.calls.length, 0);
});

test('safeFetch: always passes redirect:manual and never lets fetchImpl/allowHttp leak into the request', async () => {
  const s = stub(() => html('ok'));
  await safeFetch('https://example.com/', { fetchImpl: s.fn, method: 'POST', body: 'a=b', redirect: 'follow' });
  assert.equal(s.calls[0].init.redirect, 'manual');
  assert.equal(s.calls[0].init.method, 'POST');
  assert.equal((s.calls[0].init as any).fetchImpl, undefined);
  assert.equal((s.calls[0].init as any).allowHttp, undefined);
});

test('safeFetch: follows a chain of relative/absolute redirects and returns the FINAL url', async () => {
  const s = stub((u) => {
    if (u === 'https://example.com/a') return redirect('/b');
    if (u === 'https://example.com/b') return redirect('https://www.example.org/c?x=1', 301);
    if (u === 'https://www.example.org/c?x=1') return redirect('d', 307);
    return html('final');
  });
  const { res, url } = await safeFetch('https://example.com/a', { fetchImpl: s.fn });
  assert.equal(url, 'https://www.example.org/d');
  assert.equal(await res.text(), 'final');
  assert.deepEqual(s.calls.map((c) => c.url), ['https://example.com/a', 'https://example.com/b', 'https://www.example.org/c?x=1', 'https://www.example.org/d']);
});

test('safeFetch: stops after MAX_REDIRECTS', async () => {
  assert.equal(MAX_REDIRECTS, 4);
  const s = stub((_u, _i, n) => redirect(`https://example.com/hop${n + 1}`));
  await assert.rejects(() => safeFetch('https://example.com/hop0', { fetchImpl: s.fn }), /too many redirects/);
  assert.equal(s.calls.length, MAX_REDIRECTS + 1);
  // exactly MAX_REDIRECTS redirects then a 200 is fine
  const ok = stub((_u, _i, n) => (n < MAX_REDIRECTS ? redirect(`https://example.com/hop${n + 1}`) : html('done')));
  const r = await safeFetch('https://example.com/hop0', { fetchImpl: ok.fn });
  assert.equal(r.url, `https://example.com/hop${MAX_REDIRECTS}`);
});

test('safeFetch: redirect loop terminates; 3xx without Location is returned as is; non-redirect statuses are returned', async () => {
  const loop = stub(() => redirect('https://example.com/loop'));
  await assert.rejects(() => safeFetch('https://example.com/loop', { fetchImpl: loop.fn }), /too many redirects/);
  const noLoc = stub(() => new Response(null, { status: 304 }));
  const r = await safeFetch('https://example.com/x', { fetchImpl: noLoc.fn });
  assert.equal(r.res.status, 304);
  assert.equal(noLoc.calls.length, 1);
  const e404 = stub(() => html('nope', 404));
  assert.equal((await safeFetch('https://example.com/x', { fetchImpl: e404.fn })).res.status, 404);
});

test('safeFetch: a malformed Location header is refused, not crashed', async () => {
  const s = stub(() => redirect('http://[bad'));
  await assert.rejects(() => safeFetch('https://example.com/x', { fetchImpl: s.fn }));
  assert.equal(s.calls.length, 1);
});

// ------------------------------------------------------------------ canonicalUrl / mergeHits
const hit = (url: string, engine: string, snippet = 's', title = 't'): WebHit => ({ title, url, snippet, publishedAt: null, score: null, engine });

test('canonicalUrl: scheme, www., trailing slash, fragment and tracking params collapse', () => {
  const base = canonicalUrl('https://example.com/a/b');
  for (const u of [
    'http://example.com/a/b', 'https://www.example.com/a/b', 'https://example.com/a/b/', 'https://example.com/a/b//', 'https://EXAMPLE.com/a/b#frag',
    'https://example.com/a/b?utm_source=x', 'https://example.com/a/b?utm_source=x&utm_medium=y&utm_campaign=z', 'https://example.com/a/b?fbclid=abc', 'https://example.com/a/b?gclid=1',
    'https://example.com/a/b?utm_content=1&fbclid=2', 'https://example.com/a/b?UTM_SOURCE=x',
  ]) assert.equal(canonicalUrl(u), base, u);
  assert.equal(canonicalUrl('https://example.com'), canonicalUrl('https://example.com/'));
});

test('canonicalUrl: genuinely different pages stay different', () => {
  assert.notEqual(canonicalUrl('https://example.com/a'), canonicalUrl('https://example.com/b'));
  assert.notEqual(canonicalUrl('https://example.com/a?id=1'), canonicalUrl('https://example.com/a?id=2'));
  assert.notEqual(canonicalUrl('https://example.com/a?id=1&utm_source=x'), canonicalUrl('https://example.com/a?id=2&utm_source=x'));
  assert.notEqual(canonicalUrl('https://blog.example.com/a'), canonicalUrl('https://example.com/a'));
  assert.equal(canonicalUrl('https://example.com/a?id=1&utm_source=x'), canonicalUrl('https://example.com/a?id=1'));
  assert.equal(canonicalUrl('not a url'), 'not a url');
});

test('canonicalUrl: query-parameter order is normalised', () => {
  assert.equal(canonicalUrl('https://example.com/p?a=1&b=2'), canonicalUrl('https://example.com/p?b=2&a=1'));
});

test('canonicalUrl: MailChimp mc_cid / mc_eid tracking params collapse', () => {
  assert.equal(canonicalUrl('https://example.com/p?mc_cid=1&mc_eid=2'), canonicalUrl('https://example.com/p'));
});

test('canonicalUrl: different ports are different pages', () => {
  assert.notEqual(canonicalUrl('https://example.com:8443/a'), canonicalUrl('https://example.com/a'));
});

test('mergeHits: collapses duplicates across providers and combines engine labels', () => {
  const a = [hit('https://example.com/x', 'searxng:google'), hit('https://other.com/1', 'searxng:google')];
  const b = [hit('http://www.example.com/x/?utm_source=n&fbclid=1', 'tavily'), hit('https://third.com/', 'tavily')];
  const m = mergeHits([a, b], 10);
  assert.equal(m.length, 3);
  const x = m.find((h) => h.url.includes('example.com/x'))!;
  assert.equal(x.engine, 'searxng:google+tavily');
  assert.equal(x.url, 'https://example.com/x');          // the first provider's spelling is kept
});

test('mergeHits: duplicate fills in an empty snippet from the other provider', () => {
  const m = mergeHits([[hit('https://e.com/x', 'searxng:bing', '')], [hit('https://e.com/x/', 'tavily', 'good text')]], 10);
  assert.equal(m.length, 1);
  assert.equal(m[0].snippet, 'good text');
  assert.equal(m[0].engine, 'searxng:bing+tavily');
  // identical engine on both: no "x+x"
  const same = mergeHits([[hit('https://e.com/x', 'tavily')], [hit('https://e.com/x', 'tavily')]], 10);
  assert.equal(same[0].engine, 'tavily');
});

test('mergeHits: interleaves so one provider cannot fill the whole budget', () => {
  const a = Array.from({ length: 10 }, (_, i) => hit(`https://a.com/${i}`, 'searxng'));
  const b = Array.from({ length: 10 }, (_, i) => hit(`https://b.com/${i}`, 'tavily'));
  const m = mergeHits([a, b], 4);
  assert.deepEqual(m.map((h) => h.url), ['https://a.com/0', 'https://b.com/0', 'https://a.com/1', 'https://b.com/1']);
  const three = mergeHits([a, b, [hit('https://c.com/0', 'x')]], 3);
  assert.deepEqual(three.map((h) => h.url), ['https://a.com/0', 'https://b.com/0', 'https://c.com/0']);
});

test('mergeHits: honours the max cap exactly and handles degenerate input', () => {
  const many = Array.from({ length: 30 }, (_, i) => hit(`https://a.com/${i}`, 'searxng'));
  assert.equal(mergeHits([many], 6).length, 6);
  assert.equal(mergeHits([many], 1).length, 1);
  assert.equal(mergeHits([many], 100).length, 30);
  assert.deepEqual(mergeHits([], 5), []);
  assert.deepEqual(mergeHits([[], []], 5), []);
  const uneven = mergeHits([[hit('https://a.com/1', 'x')], Array.from({ length: 5 }, (_, i) => hit(`https://b.com/${i}`, 'y'))], 4);
  assert.equal(uneven.length, 4);
  // duplicates do not count against the cap
  const dup = [hit('https://a.com/1', 'x'), hit('https://a.com/2', 'x'), hit('https://a.com/3', 'x')];
  const dup2 = [hit('https://a.com/1/', 'y'), hit('https://a.com/2/', 'y'), hit('https://a.com/3/', 'y')];
  assert.equal(mergeHits([dup, dup2], 3).length, 3);
});

test('mergeHits: max 0 returns nothing', () => {
  assert.equal(mergeHits([[hit('https://a.com/1', 'x')]], 0).length, 0);
});

// ------------------------------------------------------------------ webConfig
test('webConfig: defaults for null / undefined / empty rows', () => {
  for (const row of [null, undefined, {}]) {
    const c = webConfig(row as any);
    assert.equal(c.enabled, false);
    assert.equal(c.searxngUrl, null);
    assert.equal(c.merge, false);
    assert.equal(c.searxngAllowHttp, false);
    assert.deepEqual(c.providers, ['searxng', 'brave', 'tavily']);
    assert.equal(c.maxResults, WEB_DEFAULTS.MAX_RESULTS);
    assert.equal(c.allowedRoles, null);
  }
});

test('webConfig: enabled only for a literal true (not "true", 1, "on")', () => {
  for (const v of ['true', 1, 'on', 'yes', {}, [], null, undefined, false]) assert.equal(webConfig({ web_search_enabled: v }).enabled, false, String(v));
  assert.equal(webConfig({ web_search_enabled: true }).enabled, true);
  assert.equal(webConfig({ web_merge: 'true' }).merge, false);
  assert.equal(webConfig({ searxng_allow_http: 1 }).searxngAllowHttp, false);
});

test('webConfig: searxng_url trimmed; blank / non-string -> null', () => {
  assert.equal(webConfig({ searxng_url: '  https://s.example.com/  ' }).searxngUrl, 'https://s.example.com/');
  for (const v of ['', '   ', 5, {}, null, undefined, false]) assert.equal(webConfig({ searxng_url: v }).searxngUrl, null, String(v));
});

test('webConfig: web_max_results is clamped', () => {
  assert.equal(webConfig({ web_max_results: 3 }).maxResults, 3);
  assert.equal(webConfig({ web_max_results: '8' }).maxResults, 8);
  assert.equal(webConfig({ web_max_results: 20 }).maxResults, 20);
  assert.equal(webConfig({ web_max_results: 21 }).maxResults, 20);
  assert.equal(webConfig({ web_max_results: 9999999 }).maxResults, 20);
  assert.equal(webConfig({ web_max_results: Infinity }).maxResults, WEB_DEFAULTS.MAX_RESULTS);
  assert.equal(webConfig({ web_max_results: 7.9 }).maxResults, 7);
  for (const v of [0, -5, NaN, 'abc', null, undefined, {}]) assert.equal(webConfig({ web_max_results: v }).maxResults, WEB_DEFAULTS.MAX_RESULTS, String(v));
});

test('webConfig: a fractional web_max_results below 1 must not give 0 results', () => {
  assert.ok(webConfig({ web_max_results: 0.5 }).maxResults >= 1);
});

test('webConfig: junk in web_providers is dropped, order kept, all-junk falls back to defaults', () => {
  assert.deepEqual(webConfig({ web_providers: ['tavily', 'searxng'] }).providers, ['tavily', 'searxng']);
  assert.deepEqual(webConfig({ web_providers: ['bing', 'tavily', 5, null, {}, 'SEARXNG', 'google'] }).providers, ['tavily']);
  assert.deepEqual(webConfig({ web_providers: ['bing', 5] }).providers, ['searxng', 'brave', 'tavily']);
  assert.deepEqual(webConfig({ web_providers: [] }).providers, ['searxng', 'brave', 'tavily']);
  assert.deepEqual(webConfig({ web_providers: 'tavily' }).providers, ['searxng', 'brave', 'tavily']);
  assert.deepEqual(webConfig({ web_providers: { 0: 'tavily' } }).providers, ['searxng', 'brave', 'tavily']);
});

test('webConfig: duplicate providers are collapsed', () => {
  assert.deepEqual(webConfig({ web_providers: ['tavily', 'tavily'] }).providers, ['tavily']);
});

test('webConfig: allowed roles lower-cased; non-array -> null', () => {
  assert.deepEqual(webConfig({ web_allowed_roles: ['Boss', 'TL'] }).allowedRoles, ['boss', 'tl']);
  assert.equal(webConfig({ web_allowed_roles: 'boss' }).allowedRoles, null);
  assert.deepEqual(webConfig({ web_allowed_roles: [] }).allowedRoles, []);
});

// ------------------------------------------------------------------ webAllowedForRole / usableProviders
test('webAllowedForRole: disabled blocks everyone; roles are matched case-insensitively', () => {
  const off = webConfig({ web_search_enabled: false });
  assert.equal(webAllowedForRole(off, 'boss'), false);
  const all = webConfig({ web_search_enabled: true });
  assert.equal(webAllowedForRole(all, 'anyone'), true);
  const some = webConfig({ web_search_enabled: true, web_allowed_roles: ['Boss', 'tl'] });
  assert.equal(webAllowedForRole(some, 'BOSS'), true);
  assert.equal(webAllowedForRole(some, 'TL'), true);
  assert.equal(webAllowedForRole(some, 'ol'), false);
  assert.equal(webAllowedForRole(some, undefined as any), false);
  const none = webConfig({ web_search_enabled: true, web_allowed_roles: [] });
  assert.equal(webAllowedForRole(none, 'boss'), false);
});

test('usableProviders: a provider with no URL / key is not usable', () => {
  const env = (row: any, keys: any): WebEnv => ({ config: webConfig(row), keys });
  assert.deepEqual(usableProviders(env({}, {})), []);
  assert.deepEqual(usableProviders(env({}, { tavily: '' })), []);
  assert.deepEqual(usableProviders(env({}, { tavily: null })), []);
  assert.deepEqual(usableProviders(env({ searxng_url: '   ' }, {})), []);
  assert.deepEqual(usableProviders(env({ searxng_url: 'https://s.example.com' }, {})), ['searxng']);
  assert.deepEqual(usableProviders(env({}, { tavily: 'tvly-x' })), ['tavily']);
  assert.deepEqual(usableProviders(env({ searxng_url: 'https://s.example.com' }, { tavily: 'tvly-x' })), ['searxng', 'tavily']);
  assert.deepEqual(usableProviders(env({ searxng_url: 'https://s.example.com', web_providers: ['tavily', 'searxng'] }, { tavily: 'tvly-x' })), ['tavily', 'searxng']);
  assert.deepEqual(usableProviders(env({ web_providers: ['tavily'], searxng_url: 'https://s.example.com' }, {})), []);
});

// ------------------------------------------------------------------ searxngSearch
const SX = { baseUrl: 'https://search.example.com' };

test('searxngSearch: POSTs form-encoded with format=json to /search', async () => {
  const s = stub(() => json({ results: [] }));
  await searxngSearch({ query: 'wurx media & co', timeRange: 'month', categories: 'news' }, { ...SX, fetchImpl: s.fn });
  assert.equal(s.calls.length, 1);
  const c = s.calls[0];
  assert.equal(c.url, 'https://search.example.com/search');
  assert.equal(c.init.method, 'POST');
  assert.equal((c.init.headers as any)['content-type'], 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(String(c.init.body));
  assert.equal(form.get('format'), 'json');
  assert.equal(form.get('q'), 'wurx media & co');
  assert.equal(form.get('categories'), 'news');
  assert.equal(form.get('time_range'), 'month');
  assert.equal(form.get('pageno'), '1');
  assert.ok(!c.url.includes('wurx'), 'the query must not appear in the URL');
});

test('searxngSearch: base URL normalisation (/search suffix, trailing slashes) and the missing-URL error', async () => {
  for (const base of ['https://s.example.com/', 'https://s.example.com///', 'https://s.example.com/search', 'https://s.example.com/search/']) {
    const s = stub(() => json({ results: [] }));
    await searxngSearch({ query: 'q' }, { baseUrl: base, fetchImpl: s.fn });
    assert.equal(s.calls[0].url, 'https://s.example.com/search', base);
  }
  const s = stub(() => json({}));
  for (const b of ['', '   ', undefined as any, null as any]) await assert.rejects(() => searxngSearch({ query: 'q' }, { baseUrl: b, fetchImpl: s.fn }), /no SearXNG URL/);
  assert.equal(s.calls.length, 0);
});

test('searxngSearch: 403 explains that json must be enabled in search.formats', async () => {
  const s = stub(() => new Response('Forbidden', { status: 403 }));
  const e: any = await searxngSearch({ query: 'q' }, { ...SX, fetchImpl: s.fn }).catch((x) => x);
  assert.ok(e instanceof SearxngError);
  assert.equal(e.status, 403);
  assert.match(e.hint, /search\.formats/);
  assert.match(e.hint, /json/);
  assert.match(describeProviderError(e), /search\.formats/);
});

test('searxngSearch: 429 and 500 give distinct, non-crashing errors', async () => {
  const e429: any = await searxngSearch({ query: 'q' }, { ...SX, fetchImpl: stub(() => new Response('', { status: 429 })).fn }).catch((x) => x);
  assert.match(e429.hint, /rate-limit/);
  const e500: any = await searxngSearch({ query: 'q' }, { ...SX, fetchImpl: stub(() => new Response('boom', { status: 500 })).fn }).catch((x) => x);
  assert.ok(e500 instanceof SearxngError);
  assert.equal(e500.hint, null);
  assert.match(e500.message, /HTTP 500/);
});

test('searxngSearch: an HTML body (JSON disabled) is a clear SearxngError, not a crash', async () => {
  const s = stub(() => html('<!doctype html><html><body>SearXNG</body></html>'));
  const e: any = await searxngSearch({ query: 'q' }, { ...SX, fetchImpl: s.fn }).catch((x) => x);
  assert.ok(e instanceof SearxngError, String(e));
  assert.match(e.message, /did not return JSON/);
  assert.match(e.message, /search\.formats/);
  // empty body, and "null" JSON
  await assert.rejects(() => searxngSearch({ query: 'q' }, { ...SX, fetchImpl: stub(() => new Response('')).fn }), SearxngError);
  assert.deepEqual((await searxngSearch({ query: 'q' }, { ...SX, fetchImpl: stub(() => new Response('null')).fn })).hits, []);
});

test('searxngSearch: well-formed JSON maps to hits', async () => {
  const body = {
    results: [
      { title: 'Alpha', url: 'https://a.example/1', content: 'about alpha', engine: 'google', score: 1.5, publishedDate: '2026-09-01T00:00:00' },
      { title: '', url: 'https://b.example/2', content: null, engine: 'bing' },
      { title: 'no url', content: 'dropped' },
      { title: 'Plain', url: 'https://c.example/3', content: 'x'.repeat(5000), score: 'high' },
      { title: 'T'.repeat(500), url: 'https://d.example/4' },
    ],
  };
  const { hits } = await searxngSearch({ query: 'q', maxResults: 10 }, { ...SX, fetchImpl: stub(() => json(body)).fn });
  assert.equal(hits.length, 4);
  assert.deepEqual(hits[0], { title: 'Alpha', url: 'https://a.example/1', snippet: 'about alpha', publishedAt: '2026-09-01T00:00:00', score: 1.5, engine: 'searxng:google' });
  assert.equal(hits[1].title, 'https://b.example/2');
  assert.equal(hits[1].snippet, '');
  assert.equal(hits[1].engine, 'searxng:bing');
  assert.equal(hits[2].engine, 'searxng');
  assert.equal(hits[2].snippet.length, 1200);
  assert.equal(hits[2].score, null);
  assert.equal(hits[3].title.length, 300);
});

test('searxngSearch: maxResults is honoured and clamped', async () => {
  const body = { results: Array.from({ length: 30 }, (_, i) => ({ title: `t${i}`, url: `https://e.com/${i}` })) };
  const f = () => stub(() => json(body)).fn;
  assert.equal((await searxngSearch({ query: 'q', maxResults: 3 }, { ...SX, fetchImpl: f() })).hits.length, 3);
  assert.equal((await searxngSearch({ query: 'q', maxResults: 99 }, { ...SX, fetchImpl: f() })).hits.length, 20);
  assert.equal((await searxngSearch({ query: 'q', maxResults: 0 }, { ...SX, fetchImpl: f() })).hits.length, 1);
  assert.equal((await searxngSearch({ query: 'q' }, { ...SX, fetchImpl: f() })).hits.length, 6);
});

test('searxngSearch: unicode, huge queries and results that are not arrays do not crash', async () => {
  const s = stub(() => json({ results: [{ title: '中文😀', url: 'https://e.com/é', content: 'مرحبا' }] }));
  const r = await searxngSearch({ query: 'é中文😀 مرحبا'.repeat(2000) }, { ...SX, fetchImpl: s.fn });
  assert.equal(r.hits[0].title, '中文😀');
  assert.equal(new URLSearchParams(String(s.calls[0].init.body)).get('q'), 'é中文😀 مرحبا'.repeat(2000));
});

test('searxngSearch: a non-array "results" gives an empty list, not a TypeError', async () => {
  const r = await searxngSearch({ query: 'q' }, { ...SX, fetchImpl: stub(() => json({ results: 'oops' })).fn });
  assert.deepEqual(r.hits, []);
});

test('searxngSearch: the instance URL goes through the SSRF guard (private/metadata base URLs refused, no fetch)', async () => {
  for (const base of ['https://169.254.169.254', 'https://localhost', 'https://10.0.0.1', 'http://example.com']) {
    const s = stub(() => json({ results: [] }));
    await assert.rejects(() => searxngSearch({ query: 'q' }, { baseUrl: base, fetchImpl: s.fn }), /refused/, base);
    assert.equal(s.calls.length, 0);
  }
  // an instance that redirects to the metadata host
  const s = stub(() => redirect('http://169.254.169.254/'));
  await assert.rejects(() => searxngSearch({ query: 'q' }, { ...SX, fetchImpl: s.fn, allowHttp: true }), /refused/);
  assert.equal(s.calls.length, 1);
});

test('searxngSearch: allowHttp lets an http instance through', async () => {
  const s = stub(() => json({ results: [] }));
  await searxngSearch({ query: 'q' }, { baseUrl: 'http://search.example.com:8080', fetchImpl: s.fn, allowHttp: true });
  assert.equal(s.calls[0].url, 'http://search.example.com:8080/search');
});

test('searxngSearch: a LAN instance over plain http works when the admin opts in', async () => {
  const s = stub(() => json({ results: [] }));
  await searxngSearch({ query: 'q' }, { baseUrl: 'http://192.168.1.20:8080', fetchImpl: s.fn, allowHttp: true });
  assert.equal(s.calls.length, 1);
});

// ------------------------------------------------------------------ tavilySearch
const TV = { apiKey: 'tvly-TEST-KEY' };

test('tavilySearch: request shape and Bearer auth', async () => {
  const s = stub(() => json({ results: [] }));
  await tavilySearch({ query: 'wurx', maxResults: 5, topic: 'news', timeRange: 'week', includeDomains: ['a.com'], excludeDomains: ['b.com'] }, { ...TV, fetchImpl: s.fn });
  const c = s.calls[0];
  assert.equal(c.url, 'https://api.tavily.com/search');
  assert.equal(c.init.method, 'POST');
  const h = c.init.headers as any;
  assert.equal(h.authorization, 'Bearer tvly-TEST-KEY');
  assert.equal(h['content-type'], 'application/json');
  const b = JSON.parse(String(c.init.body));
  assert.equal(b.query, 'wurx');
  assert.equal(b.max_results, 5);
  assert.equal(b.topic, 'news');
  assert.equal(b.time_range, 'week');
  assert.deepEqual(b.include_domains, ['a.com']);
  assert.deepEqual(b.exclude_domains, ['b.com']);
  assert.equal(b.include_raw_content, false);
  assert.equal(b.include_images, false);
  assert.ok(!String(c.init.body).includes('tvly-TEST-KEY'), 'the key must never be in the body');
  assert.ok(!c.url.includes('tvly-TEST-KEY'), 'the key must never be in the URL');
});

test('tavilySearch: max_results clamped to 1..20; optional fields omitted; country forces topic general', async () => {
  const run = async (a: any) => { const s = stub(() => json({})); await tavilySearch({ query: 'q', ...a }, { ...TV, fetchImpl: s.fn }); return JSON.parse(String(s.calls[0].init.body)); };
  assert.equal((await run({ maxResults: 0 })).max_results, 1);
  assert.equal((await run({ maxResults: -4 })).max_results, 1);
  assert.equal((await run({ maxResults: 500 })).max_results, 20);
  assert.equal((await run({})).max_results, 6);
  const b = await run({});
  for (const k of ['time_range', 'include_domains', 'exclude_domains', 'country']) assert.ok(!(k in b), k);
  const c = await run({ country: 'pakistan', topic: 'news' });
  assert.equal(c.country, 'pakistan');
  assert.equal(c.topic, 'general');
  assert.equal((await run({ includeDomains: Array.from({ length: 400 }, (_, i) => `d${i}.com`) })).include_domains.length, 300);
  assert.equal((await run({ excludeDomains: Array.from({ length: 400 }, (_, i) => `d${i}.com`) })).exclude_domains.length, 150);
});

test('tavilySearch: maps results[] title/url/content/score/published_date, answer and usage.credits', async () => {
  const body = {
    query: 'q', answer: '  The short answer.  ', response_time: 1.2,
    results: [
      { title: 'One', url: 'https://one.example/', content: 'snippet one', score: 0.91, published_date: 'Mon, 29 Sep 2026 10:00:00 GMT', raw_content: null },
      { title: '', url: 'https://two.example/', content: '', score: 0.5 },
      { title: 'no url', content: 'dropped', score: 0.4 },
      { title: 'Three', url: 'https://three.example/', content: 'c'.repeat(3000), score: '0.1' },
    ],
    usage: { credits: 2 }, request_id: 'abc',
  };
  const r = await tavilySearch({ query: 'q' }, { ...TV, fetchImpl: stub(() => json(body)).fn });
  assert.equal(r.credits, 2);
  assert.equal(r.answer, 'The short answer.');
  assert.equal(r.hits.length, 3);
  assert.deepEqual(r.hits[0], { title: 'One', url: 'https://one.example/', snippet: 'snippet one', publishedAt: 'Mon, 29 Sep 2026 10:00:00 GMT', score: 0.91, engine: 'tavily' });
  assert.equal(r.hits[1].title, 'https://two.example/');
  assert.equal(r.hits[1].publishedAt, null);
  assert.equal(r.hits[2].snippet.length, 1200);
  assert.equal(r.hits[2].score, null);
});

test('tavilySearch: missing usage / answer / results are harmless', async () => {
  const r = await tavilySearch({ query: 'q' }, { ...TV, fetchImpl: stub(() => json({})).fn });
  assert.deepEqual(r, { hits: [], answer: null, credits: 0 });
  const r2 = await tavilySearch({ query: 'q' }, { ...TV, fetchImpl: stub(() => json({ answer: '   ', results: null, usage: { credits: 'x' } })).fn });
  assert.equal(r2.answer, null);
  assert.ok(Number.isNaN(r2.credits) === false || true);
});

test('tavilySearch: non-numeric usage.credits must not become NaN', async () => {
  const r = await tavilySearch({ query: 'q' }, { ...TV, fetchImpl: stub(() => json({ usage: { credits: 'x' } })).fn });
  assert.ok(Number.isFinite(r.credits));
});

test('tavilySearch: HTTP errors become TavilyError with the status and the detail message', async () => {
  const mk = (status: number, body: unknown) => tavilySearch({ query: 'q' }, { ...TV, fetchImpl: stub(() => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })).fn }).catch((x) => x);
  const e401: any = await mk(401, { detail: { error: 'Unauthorized: missing or invalid API key.' } });
  assert.ok(e401 instanceof TavilyError);
  assert.equal(e401.status, 401);
  assert.match(e401.message, /Unauthorized/);
  assert.equal(describeProviderError(e401), 'Tavily refused the API key.');
  const e432: any = await mk(432, { detail: { error: 'This request exceeds your plan set usage limit.' } });
  assert.equal(describeProviderError(e432), 'The Tavily plan is out of credits.');
  assert.equal(describeProviderError(await mk(433, { detail: { error: 'pay-as-you-go limit' } })), 'The Tavily plan is out of credits.');
  assert.equal(describeProviderError(await mk(429, { detail: { error: 'Too many requests' } })), 'Tavily is rate-limiting us.');
  const e500: any = await mk(500, 'upstream exploded');
  assert.match(describeProviderError(e500), /^Tavily error: upstream exploded/);
  const eStr: any = await mk(400, { detail: 'plain string detail' });
  assert.equal(eStr.message, 'plain string detail');
  const eBig: any = await mk(500, 'x'.repeat(5000));
  assert.ok(eBig.message.length <= 300);
});

test('tavilySearch: a 200 with a non-JSON body is a TavilyError, not a crash', async () => {
  const e: any = await tavilySearch({ query: 'q' }, { ...TV, fetchImpl: stub(() => html('<html>captive portal</html>')).fn }).catch((x) => x);
  assert.ok(e instanceof TavilyError);
  assert.match(e.message, /non-JSON/);
});

test('tavilySearch: the API key never appears in an error message', async () => {
  const e: any = await tavilySearch({ query: 'q' }, { ...TV, fetchImpl: stub(() => new Response('bad key tvly-TEST-KEY', { status: 401 })).fn }).catch((x) => x);
  // the provider echoes it back here; describeProviderError (what reaches logs/UI) replaces 401 with a fixed string
  assert.ok(!describeProviderError(e).includes('tvly-TEST-KEY'));
});

// ------------------------------------------------------------------ tavilyExtract
test('tavilyExtract: request shape, Bearer auth, urls capped at 20', async () => {
  const s = stub(() => json({ results: [], failed_results: [] }));
  await tavilyExtract(Array.from({ length: 30 }, (_, i) => `https://e.com/${i}`), { ...TV, fetchImpl: s.fn, query: 'pricing' });
  const c = s.calls[0];
  assert.equal(c.url, 'https://api.tavily.com/extract');
  assert.equal((c.init.headers as any).authorization, 'Bearer tvly-TEST-KEY');
  const b = JSON.parse(String(c.init.body));
  assert.equal(b.urls.length, 20);
  assert.equal(b.format, 'markdown');
  assert.equal(b.extract_depth, 'basic');
  assert.equal(b.include_usage, true);
  assert.equal(b.query, 'pricing');
});

test('tavilyExtract: reads results (raw_content) and usage.credits', async () => {
  const r = await tavilyExtract(['https://e.com/a'], { ...TV, fetchImpl: stub(() => json({ results: [{ url: 'https://e.com/a', raw_content: '# Title\nbody' }, { url: 'https://e.com/b', raw_content: '' }, { raw_content: 'no url' }], failed_results: [], usage: { credits: 1 } })).fn });
  assert.equal(r.credits, 1);
  assert.deepEqual(r.pages, [{ url: 'https://e.com/a', title: null, text: '# Title\nbody', source: 'tavily' }]);
  assert.deepEqual(r.failed, []);
});

test('tavilyExtract: HTTP 200 with empty results and populated failed_results is a failure, not a crash', async () => {
  const body = { results: [], failed_results: [{ url: 'https://e.com/a', error: 'Failed to fetch url' }, { url: 'https://e.com/b' }], response_time: 0.3, usage: { credits: 0 } };
  const r = await tavilyExtract(['https://e.com/a', 'https://e.com/b'], { ...TV, fetchImpl: stub(() => json(body)).fn });
  assert.deepEqual(r.pages, []);
  assert.deepEqual(r.failed, [{ url: 'https://e.com/a', error: 'Failed to fetch url' }, { url: 'https://e.com/b', error: 'extraction failed' }]);
  assert.equal(r.credits, 0);
  // missing arrays entirely
  assert.deepEqual(await tavilyExtract(['https://e.com/a'], { ...TV, fetchImpl: stub(() => json({})).fn }), { pages: [], failed: [], credits: 0 });
});

// ------------------------------------------------------------------ webSearch (orchestration)
const envOf = (row: any, keys: any, f: typeof fetch): WebEnv => ({ config: webConfig({ web_search_enabled: true, ...row }), keys, fetchImpl: f });
const SXROUTE = (u: string) => u.startsWith('https://search.example.com');

test('webSearch: nothing configured -> a clear error and zero fetches', async () => {
  const s = stub(() => json({}));
  const o = await webSearch(envOf({}, {}, s.fn), { query: 'q' });
  assert.deepEqual(o.hits, []);
  assert.equal(o.errors[0].provider, 'none');
  assert.equal(s.calls.length, 0);
});

test('webSearch: first-that-works stops at SearXNG when it has hits (Tavily credits not spent)', async () => {
  const s = stub((u) => (SXROUTE(u) ? json({ results: [{ title: 'a', url: 'https://a.com/', content: 'x', engine: 'g' }] }) : json({ results: [] })));
  const o = await webSearch(envOf({ searxng_url: 'https://search.example.com' }, { tavily: 'k' }, s.fn), { query: 'q' });
  assert.equal(o.hits.length, 1);
  assert.deepEqual(o.providersTried, ['searxng']);
  assert.ok(s.calls.every((c) => !c.url.includes('tavily')));
  assert.deepEqual(o.usage, [{ provider: 'searxng', calls: 1, credits: 0 }]);
});

test('webSearch: SearXNG down or empty -> falls through to Tavily and records the SearXNG error', async () => {
  const down = stub((u) => (SXROUTE(u) ? new Response('Forbidden', { status: 403 }) : json({ results: [{ title: 't', url: 'https://t.com/', content: 'c' }], answer: 'ans', usage: { credits: 1 } })));
  const o = await webSearch(envOf({ searxng_url: 'https://search.example.com' }, { tavily: 'k' }, down.fn), { query: 'q' });
  assert.equal(o.hits[0].engine, 'tavily');
  assert.equal(o.answer, 'ans');
  assert.deepEqual(o.providersTried, ['searxng', 'tavily']);
  assert.equal(o.errors.length, 1);
  assert.match(o.errors[0].error, /search\.formats/);
  assert.deepEqual(o.usage, [{ provider: 'tavily', calls: 1, credits: 1 }]);
  const empty = stub((u) => (SXROUTE(u) ? json({ results: [] }) : json({ results: [{ title: 't', url: 'https://t.com/', content: 'c' }] })));
  const o2 = await webSearch(envOf({ searxng_url: 'https://search.example.com' }, { tavily: 'k' }, empty.fn), { query: 'q' });
  assert.equal(o2.hits.length, 1);
  assert.equal(o2.errors.length, 0);
});

test('webSearch: merge mode runs both and dedupes; all-fail returns errors and no hits', async () => {
  const both = stub((u) => (SXROUTE(u)
    ? json({ results: [{ title: 'a', url: 'https://a.com/x', content: 'x', engine: 'g' }] })
    : json({ results: [{ title: 'a', url: 'http://www.a.com/x/?utm_source=t', content: 'x' }, { title: 'b', url: 'https://b.com/', content: 'y' }] })));
  const o = await webSearch(envOf({ searxng_url: 'https://search.example.com', web_merge: true }, { tavily: 'k' }, both.fn), { query: 'q', maxResults: 5 });
  assert.equal(o.hits.length, 2);
  assert.equal(o.hits[0].engine, 'searxng:g+tavily');
  const fail = stub(() => new Response('x', { status: 500 }));
  const o2 = await webSearch(envOf({ searxng_url: 'https://search.example.com' }, { tavily: 'k' }, fail.fn), { query: 'q' });
  assert.deepEqual(o2.hits, []);
  assert.equal(o2.errors.length, 2);
});

test('webSearch: week time range is widened to month for SearXNG; news topic maps to the news category', async () => {
  const s = stub(() => json({ results: [] }));
  await webSearch(envOf({ searxng_url: 'https://search.example.com' }, {}, s.fn), { query: 'q', timeRange: 'week', topic: 'news' });
  const form = new URLSearchParams(String(s.calls[0].init.body));
  assert.equal(form.get('time_range'), 'month');
  assert.equal(form.get('categories'), 'news');
});

// ------------------------------------------------------------------ webFetchPage
const READ = 'https://example.com/article';

test('webFetchPage: no Tavily key -> direct guarded fetch, html converted to text', async () => {
  const s = stub(() => html('<html><head><title>My &amp; Page</title><style>x{}</style></head><body><script>evil()</script><h1>Head</h1><p>Hello <b>world</b></p></body></html>'));
  const r = await webFetchPage(envOf({}, {}, s.fn), READ);
  assert.equal(r.error, null);
  assert.equal(r.page!.source, 'direct');
  assert.equal(r.page!.title, 'My & Page');
  assert.match(r.page!.text, /# Head/);
  assert.match(r.page!.text, /Hello world/);
  assert.ok(!/evil|x\{\}/.test(r.page!.text));
  assert.equal(r.page!.url, READ);
  assert.deepEqual(r.usage, [{ provider: 'direct', calls: 1, credits: 0 }]);
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].init.redirect, 'manual');
});

test('webFetchPage: Tavily first; success returns without a direct fetch and reports credits', async () => {
  const s = stub(() => json({ results: [{ url: READ, raw_content: 'tavily text' }], failed_results: [], usage: { credits: 1 } }));
  const r = await webFetchPage(envOf({}, { tavily: 'k' }, s.fn), READ);
  assert.equal(r.page!.source, 'tavily');
  assert.equal(r.page!.text, 'tavily text');
  assert.deepEqual(r.usage, [{ provider: 'tavily', calls: 1, credits: 1 }]);
  assert.equal(s.calls.length, 1);
});

test('webFetchPage: Tavily HTTP error falls back to a direct guarded fetch', async () => {
  const s = stub((u) => (u.startsWith('https://api.tavily.com') ? new Response('{"detail":{"error":"plan"}}', { status: 432 }) : html('<p>direct body here</p>')));
  const r = await webFetchPage(envOf({}, { tavily: 'k' }, s.fn), READ);
  assert.equal(r.page!.source, 'direct');
  assert.match(r.page!.text, /direct body here/);
  assert.equal(s.calls.length, 2);
});

test('webFetchPage: Tavily 200 + empty results + failed_results falls back to direct fetch', async () => {
  const s = stub((u) => (u.startsWith('https://api.tavily.com') ? json({ results: [], failed_results: [{ url: READ, error: 'blocked' }], usage: { credits: 0 } }) : html('<p>fallback ok</p>')));
  const r = await webFetchPage(envOf({}, { tavily: 'k' }, s.fn), READ);
  assert.equal(r.page!.source, 'direct');
  assert.equal(r.error, null);
  // and when the direct fetch fails too, the error mentions both
  const s2 = stub((u) => (u.startsWith('https://api.tavily.com') ? json({ results: [], failed_results: [{ url: READ, error: 'blocked' }] }) : html('gone', 404)));
  const r2 = await webFetchPage(envOf({}, { tavily: 'k' }, s2.fn), READ);
  assert.equal(r2.page, null);
  assert.match(r2.error!, /Tavily could not read it \(blocked\)/);
  assert.match(r2.error!, /HTTP 404/);
});

test('webFetchPage: refuses a non-HTML content-type', async () => {
  for (const type of ['application/pdf', 'image/png', 'application/octet-stream', 'video/mp4', 'application/zip', '']) {
    const s = stub(() => new Response(new Uint8Array([1, 2, 3, 0x42]), { status: 200, headers: type ? { 'content-type': type } : {} }));
    const r = await webFetchPage(envOf({}, {}, s.fn), READ);
    assert.equal(r.page, null, type);
    assert.match(r.error!, /not a readable page/, type);
  }
  for (const type of ['text/html', 'TEXT/HTML; charset=UTF-8', 'text/plain', 'application/xhtml+xml', 'application/json', 'text/markdown']) {
    const s = stub(() => new Response('<p>content here</p>', { headers: { 'content-type': type } }));
    const r = await webFetchPage(envOf({}, {}, s.fn), READ);
    assert.ok(r.page, type);
  }
});

test('webFetchPage: honours the character cap on both paths', async () => {
  const big = '<p>' + 'word '.repeat(100_000) + '</p>';
  const d = await webFetchPage(envOf({}, {}, stub(() => html(big)).fn), READ);
  assert.equal(d.page!.text.length, WEB_DEFAULTS.PAGE_CHAR_CAP);
  const d2 = await webFetchPage(envOf({}, {}, stub(() => html(big)).fn), READ, { charCap: 100 });
  assert.equal(d2.page!.text.length, 100);
  const t = await webFetchPage(envOf({}, { tavily: 'k' }, stub(() => json({ results: [{ url: READ, raw_content: 'y'.repeat(50_000) }] })).fn), READ, { charCap: 500 });
  assert.equal(t.page!.text.length, 500);
  const j = await webFetchPage(envOf({}, {}, stub(() => new Response('z'.repeat(50_000), { headers: { 'content-type': 'application/json' } })).fn), READ, { charCap: 50 });
  assert.equal(j.page!.text.length, 50);
});

test('webFetchPage: a 3 MB body is handled and still capped', async () => {
  const r = await webFetchPage(envOf({}, {}, stub(() => html('<p>' + 'a'.repeat(3_000_000) + '</p>')).fn), READ);
  assert.equal(r.page!.text.length, WEB_DEFAULTS.PAGE_CHAR_CAP);
});

test('webFetchPage: HTTP error, empty page and unreadable page give an error, never a crash', async () => {
  assert.match((await webFetchPage(envOf({}, {}, stub(() => html('x', 500)).fn), READ)).error!, /HTTP 500/);
  assert.match((await webFetchPage(envOf({}, {}, stub(() => html('<script>only()</script>')).fn), READ)).error!, /no readable text/);
  assert.match((await webFetchPage(envOf({}, {}, stub(() => { throw new Error('socket hang up'); }).fn), READ)).error!, /socket hang up/);
});

test('webFetchPage: direct fetch refuses private / metadata targets and a redirect into them (no request to the target)', async () => {
  for (const u of ['http://169.254.169.254/latest/meta-data/', 'https://169.254.169.254/', 'https://localhost/', 'https://10.0.0.1/', 'file:///etc/passwd', 'https://[::1]/', 'https://user:pw@example.com/']) {
    const s = stub(() => html('<p>LEAK</p>'));
    const r = await webFetchPage(envOf({}, {}, s.fn), u);
    assert.equal(r.page, null, u);
    assert.match(r.error!, /refused/, u);
    assert.equal(s.calls.length, 0, u);
  }
  const s = stub((u) => (u === READ ? redirect('http://169.254.169.254/latest/meta-data/') : html('LEAK')));
  const r = await webFetchPage(envOf({}, {}, s.fn), READ);
  assert.equal(r.page, null);
  assert.match(r.error!, /refused to fetch a redirect/);
  assert.ok(s.calls.every((c) => !c.url.includes('169.254')));
});

test('webFetchPage: follows a safe redirect and reports the FINAL url', async () => {
  const s = stub((u) => (u === READ ? redirect('https://www.example.org/moved') : html('<p>moved here</p>')));
  const r = await webFetchPage(envOf({}, {}, s.fn), READ);
  assert.equal(r.page!.url, 'https://www.example.org/moved');
});

test('webFetchPage: a URL the guard would refuse is not forwarded to the Tavily extractor', async () => {
  const s = stub((u) => (u.startsWith('https://api.tavily.com') ? json({ results: [{ url: 'x', raw_content: 'y' }] }) : html('x')));
  await webFetchPage(envOf({}, { tavily: 'k' }, s.fn), 'http://169.254.169.254/latest/meta-data/');
  assert.equal(s.calls.length, 0, `fetches made: ${s.calls.map((c) => c.url + ' ' + c.init.body).join(' | ')}`);
});

// ------------------------------------------------------------------ html.ts
test('htmlToText: entities, headings, lists, comments, hostile markup', () => {
  assert.match(decodeEntities('&amp;&lt;&#65;&#x42;&nbsp;&bogus;&#0;&#99999999;'), /^&<AB[  ]&bogus;&#0;&#99999999;$/);
  const { title, text } = htmlToText('<!-- hidden --><html><title> A\n B </title><body><h2>Sub</h2><ul><li>one</li><li>two</li></ul><p>para<br>line</p><iframe src=x>fallback</iframe><svg><text>ICON</text></svg></body>');
  assert.equal(title, 'A B');
  assert.match(text, /## Sub/);
  assert.match(text, /- one\s+- two/);
  assert.ok(!/hidden|fallback|ICON/.test(text));
  assert.deepEqual(htmlToText(''), { title: null, text: '' });
  assert.doesNotThrow(() => htmlToText('<<<>>><a<b'));
  assert.doesNotThrow(() => htmlToText('<p>مرحبا 中文 😀</p>'));
  assert.match(htmlToText('<p>مرحبا 中文 😀</p>').text, /中文/);
});

test('htmlToText: a page wrapped in <form> (ASP.NET WebForms) keeps its content', () => {
  assert.match(htmlToText('<html><body><form id="aspnetForm"><div><p>The actual article text lives here.</p></div></form></body></html>').text, /actual article/);
});

test('htmlToText: unclosed <script>/<!-- floods are linear time, not quadratic', () => {
  const t0 = Date.now();
  htmlToText('<script>'.repeat(8_000));   // measured: ~325 ms, and x4 per doubling (a 2 MB page = minutes)
  htmlToText('<!--'.repeat(8_000));        // measured: ~525 ms
  assert.ok(Date.now() - t0 < 100, `took ${Date.now() - t0} ms for 64 KB`);
});

// =================================================================== second pass: the new surface
// ------------------------------------------------------------------ ipv6Bytes
test('ipv6Bytes: parses compression, mapped dotted quads, zone ids and brackets', () => {
  const z = (n: number) => Array(n).fill(0);
  assert.deepEqual(ipv6Bytes('::'), z(16));
  assert.deepEqual(ipv6Bytes('::1'), [...z(15), 1]);
  assert.deepEqual(ipv6Bytes('[::1]'), [...z(15), 1]);
  assert.deepEqual(ipv6Bytes('::ffff:127.0.0.1'), [...z(10), 255, 255, 127, 0, 0, 1]);
  assert.deepEqual(ipv6Bytes('::ffff:7f00:1'), [...z(10), 255, 255, 127, 0, 0, 1]);
  assert.deepEqual(ipv6Bytes('::127.0.0.1'), [...z(12), 127, 0, 0, 1]);
  assert.deepEqual(ipv6Bytes('64:ff9b::a9fe:a9fe'), [0, 0x64, 0xff, 0x9b, ...z(8), 0xa9, 0xfe, 0xa9, 0xfe]);
  assert.deepEqual(ipv6Bytes('2001:db8::1'), [0x20, 0x01, 0x0d, 0xb8, ...z(11), 1]);
  assert.deepEqual(ipv6Bytes('1:2:3:4:5:6:7:8'), [0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0, 7, 0, 8]);
  assert.deepEqual(ipv6Bytes('FE80::1'), [0xfe, 0x80, ...z(13), 1]);
  assert.deepEqual(ipv6Bytes('fe80::1%eth0'), [0xfe, 0x80, ...z(13), 1]);
  assert.deepEqual(ipv6Bytes('1:2:3:4:5:6:1.2.3.4'), [0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 1, 2, 3, 4]);
  assert.deepEqual(ipv6Bytes('1::'), [0, 1, ...z(14)]);
});

test('ipv6Bytes: unparseable input is null; isPrivateIpv6 refuses it rather than guessing', () => {
  for (const bad of ['', '1.2.3.4', 'example.com', ':::', '1::2::3', ':1', '1:', 'g::1', '12345::1', '1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7', '::ffff:1.2.3', '::ffff:256.1.1.1', '::ffff:01.2.3.4']) {
    assert.equal(ipv6Bytes(bad), null, bad);
    if (bad.includes(':')) assert.equal(isPrivateIpv6(bad), true, `isPrivateIpv6(${bad})`);
  }
});

test('isPrivateIpv6: byte-level rules, including every transition format', () => {
  for (const a of ['::', '::1', 'fe80::1', 'febf::1', 'fc00::1', 'fd12::1', 'ff02::1', 'ff00::', '::7f00:1', '::a9fe:a9fe', '::8.8.8.8',
    '64:ff9b::a9fe:a9fe', '64:ff9b::7f00:1', '64:ff9b::a00:1', '2002:a9fe:a9fe::1', '2002:7f00:1::', '2002:0a00:1::', '2002:c0a8:101::',
    '::ffff:127.0.0.1', '::ffff:169.254.169.254', '::ffff:10.1.1.1', '::ffff:a9fe:a9fe']) assert.equal(isPrivateIpv6(a), true, a);
  for (const a of ['2606:4700:4700::1111', '2001:db8::1', '2a00:1450:4009:81f::200e', '::ffff:8.8.8.8', '::ffff:808:808', '64:ff9b::808:808', '2002:808:808::1', 'fec0::1' /* deprecated site-local */, 'fbff::1', 'fe7f::1'])
    assert.equal(isPrivateIpv6(a), false, a);
});

// ------------------------------------------------------------------ embeddedPrivateIp
test('embeddedPrivateIp: hostnames that spell a private IPv4, dotted or dashed', () => {
  for (const h of ['169.254.169.254.nip.io', '127-0-0-1.sslip.io', '10.0.0.1.example.com', 'foo-192-168-1-1-bar.example.com', 'a.172-16-0-1.attacker.net', '0-0-0-0.example.com', '100.64.0.1.example.org', '1.2.3.4.169.254.169.254.example.com'])
    assert.equal(embeddedPrivateIp(h), true, h);
  for (const h of ['example.com', '8.8.8.8.example.com', '1-1-1-1.example.com', '300.1.1.1.example.com', '256-1-1-1.example.com', 'v1.2.3.example.com', 'abc.def', '172-15-0-1.example.com', '172-32-0-1.example.com'])
    assert.equal(embeddedPrivateIp(h), false, h);
});

test('checkUrl: names that embed a private IP, and wildcard-DNS services, are refused', () => {
  for (const u of ['https://169.254.169.254.nip.io/latest/meta-data/', 'https://127-0-0-1.sslip.io/', 'https://anything.nip.io/', 'https://nip.io/', 'https://foo.sslip.io/', 'https://x.xip.io/', 'https://localtest.me/', 'https://sub.localtest.me/',
    'https://lvh.me/', 'https://a.lvh.me/', 'https://x.vcap.me/', 'https://x.traefik.me/', 'https://x.localho.st/', 'https://10.0.0.1.example.com/', 'https://internal-192-168-0-1.example.com/'])
    rejected(u);
  accepted('https://8.8.8.8.example.com/');
  accepted('https://example.com/nip.io');
});

// ------------------------------------------------------------------ ports
test('checkUrl: denylisted ports are refused on public hosts (also with allowPrivate); web ports pass', () => {
  for (const p of [22, 23, 25, 53, 110, 143, 389, 445, 587, 993, 1433, 2375, 3306, 3389, 5432, 5900, 6379, 9200, 11211, 27017]) {
    rejected(`https://example.com:${p}/`);
    rejected(`http://example.com:${p}/`, { allowHttp: true });
    rejected(`http://192.168.1.2:${p}/`, { allowHttp: true, allowPrivate: true });
  }
  for (const p of [443, 80, 8080, 8443, 3000, 8000, 8888, 4443]) accepted(`https://example.com:${p}/`);
  assert.match((checkUrl('https://example.com:6379/') as any).reason, /port 6379/);
});

// ------------------------------------------------------------------ allowPrivate (admin-typed SearXNG)
test('checkUrl allowPrivate: LAN / private ranges are admitted (http still needs allowHttp)', () => {
  const o = { allowHttp: true, allowPrivate: true };
  for (const u of ['http://192.168.1.20:8080', 'http://10.0.0.5/', 'http://172.16.0.9:8888/', 'http://172.31.255.255/', 'http://100.64.0.1/', 'http://[fd00::1]:8080/', 'https://nas.lan/', 'https://search.corp/', 'http://searxng:8080/', 'https://search.internal/', 'https://search.example.com/'])
    accepted(u, o);
  rejected('http://192.168.1.20:8080', { allowPrivate: true });          // plain http still needs allowHttp
  rejected('http://192.168.1.20:8080');                                   // and without allowPrivate it is refused
  accepted('https://192.168.1.20/', { allowPrivate: true });
});

test('checkUrl allowPrivate: loopback, metadata, multicast and reserved stay refused', () => {
  const o = { allowHttp: true, allowPrivate: true };
  for (const u of [
    'http://127.0.0.1/', 'http://127.1.2.3:8080/', 'http://0.0.0.0/', 'http://0.1.2.3/', 'http://169.254.169.254/', 'http://169.254.169.254/latest/meta-data/iam/security-credentials/', 'http://169.254.0.1/',
    'http://224.0.0.1/', 'http://239.1.1.1/', 'http://240.0.0.1/', 'http://255.255.255.255/',
    'http://localhost/', 'http://localhost:8080/', 'http://LOCALHOST./', 'http://metadata.google.internal/', 'http://metadata/', 'http://metadata.goog/', 'http://instance-data/', 'http://instance-data.ec2.internal/', 'http://kubernetes.default.svc/',
    'http://0177.0.0.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://2852039166/', 'http://0xA9FEA9FE/', 'http://127.1/', 'http://0/',
    'http://[::1]/', 'http://[::]/', 'http://[fe80::1]/', 'http://[ff02::1]/',
    'http://[::7f00:1]/', 'http://[::a9fe:a9fe]/', 'http://[64:ff9b::a9fe:a9fe]/', 'http://[64:ff9b::7f00:1]/', 'http://[2002:a9fe:a9fe::1]/', 'http://[2002:7f00:1::]/',
    'http://169.254.169.254.nip.io/', 'http://127-0-0-1.sslip.io/', 'http://localtest.me/',
    'ftp://192.168.1.1/', 'file:///etc/passwd', 'http://user:pw@192.168.1.1/', 'http://192.168.1.1:6379/',
  ]) rejected(u, o);
});

test('checkUrl allowPrivate: v4-mapped IPv6 spellings of loopback / metadata stay refused', { todo: 'BUG guard.ts:200: the embedded-IPv4 test only inspects ::x.x.x.x, 64:ff9b:: and 2002::, never ::ffff:0:0/96, so with allowPrivate [::ffff:127.0.0.1] and [::ffff:169.254.169.254] are ADMITTED (the no-allowPrivate path blocks them via isPrivateIpv6)' }, () => {
  const o = { allowHttp: true, allowPrivate: true };
  for (const u of ['http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[::ffff:169.254.169.254]/', 'http://[::ffff:a9fe:a9fe]/', 'http://[::ffff:0.0.0.0]/', 'http://[::ffff:224.0.0.1]/']) rejected(u, o);
});

test('searxngSearch with a LAN instance: works over http, but never reaches loopback / metadata, directly or by redirect', async () => {
  const ok = stub(() => json({ results: [{ title: 'a', url: 'https://a.com/', content: 'x' }] }));
  const r = await searxngSearch({ query: 'q' }, { baseUrl: 'http://192.168.1.20:8080', fetchImpl: ok.fn, allowHttp: true });
  assert.equal(r.hits.length, 1);
  assert.equal(ok.calls[0].url, 'http://192.168.1.20:8080/search');
  for (const base of ['http://169.254.169.254', 'http://127.0.0.1:8080', 'http://localhost:8888', 'http://[::1]:8080', 'http://metadata.google.internal', 'http://169.254.169.254.nip.io']) {
    const s = stub(() => json({ results: [] }));
    await assert.rejects(() => searxngSearch({ query: 'q' }, { baseUrl: base, fetchImpl: s.fn, allowHttp: true }), /refused/, base);
    assert.equal(s.calls.length, 0, base);
  }
  for (const to of ['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:54321/', 'http://localhost/', 'http://[::1]/']) {
    const s = stub((u) => (u.startsWith('http://192.168.1.20') ? redirect(to) : html('LEAK')));
    await assert.rejects(() => searxngSearch({ query: 'q' }, { baseUrl: 'http://192.168.1.20:8080', fetchImpl: s.fn, allowHttp: true }), /refused/, to);
    assert.equal(s.calls.length, 1, to);
  }
});

test('searxngSearch with a LAN instance: a redirect to a DIFFERENT private host is refused', { todo: 'allowPrivate is passed to every hop (guard.ts:270), so a LAN SearXNG that 302s to any other RFC1918 host (10.x, 172.16.x, .internal, .corp) is followed' }, async () => {
  const s = stub((u) => (u.startsWith('http://192.168.1.20') ? redirect('http://10.0.0.99/admin') : json({ results: [] })));
  await assert.rejects(() => searxngSearch({ query: 'q' }, { baseUrl: 'http://192.168.1.20:8080', fetchImpl: s.fn, allowHttp: true }), /refused/);
  assert.equal(s.calls.length, 1);
});

// ------------------------------------------------------------------ resolvesPublic (injected resolver)
type Resolver = (h: string, t: 'A' | 'AAAA') => Promise<string[]>;
const dns = (a: Record<string, string[] | 'throw'>, aaaa: Record<string, string[] | 'throw'> = {}) => {
  const seen: string[] = [];
  const fn: Resolver = async (h, t) => {
    seen.push(`${t}:${h}`);
    const v = (t === 'A' ? a : aaaa)[h];
    if (v === 'throw') throw new Error('NXDOMAIN');
    return v ?? [];
  };
  return { fn, seen };
};

test('resolvesPublic: public A answers pass; each type is looked up', async () => {
  const d = dns({ 'example.com': ['93.184.216.34'] }, { 'example.com': ['2606:2800:220:1:248:1893:25c8:1946'] });
  assert.deepEqual(await resolvesPublic('example.com', d.fn), { ok: true });
  assert.deepEqual([...d.seen].sort(), ['A:example.com', 'AAAA:example.com']);
});

test('resolvesPublic: ANY private answer refuses, even beside public ones (mixed answer sets)', async () => {
  for (const [name, ans] of [
    ['loopback', ['127.0.0.1']], ['metadata', ['169.254.169.254']], ['rfc1918', ['10.1.2.3']], ['mixed', ['93.184.216.34', '192.168.0.9']], ['mixed-first-private', ['10.0.0.1', '93.184.216.34']],
    ['cgnat', ['100.64.0.5']], ['zero', ['0.0.0.0']], ['multicast', ['224.0.0.1']], ['garbage', ['not-an-ip']], ['obfuscated', ['0177.0.0.1']], ['empty-string', ['']],
  ] as [string, string[]][]) {
    const r = await resolvesPublic('evil.example.com', dns({ 'evil.example.com': ans }).fn);
    assert.equal(r.ok, false, name);
    assert.match((r as any).reason, /evil\.example\.com resolves to a private address/, name);
  }
});

test('resolvesPublic: the AAAA path is judged too', async () => {
  for (const a of ['::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a9fe:a9fe', '2002:a9fe:a9fe::1', '::7f00:1', 'ff02::1', 'garbage']) {
    const r = await resolvesPublic('v6.example.com', dns({ 'v6.example.com': ['93.184.216.34'] }, { 'v6.example.com': [a] }).fn);
    assert.equal(r.ok, false, a);
  }
  // only AAAA, public
  assert.deepEqual(await resolvesPublic('v6only.example.com', dns({}, { 'v6only.example.com': ['2606:4700:4700::1111'] }).fn), { ok: true });
  // only AAAA, private
  assert.equal((await resolvesPublic('v6only.example.com', dns({}, { 'v6only.example.com': ['::1'] }).fn)).ok, false);
});

test('resolvesPublic: unresolvable hosts, throwing resolvers and null answers are let through (fetch reports the failure)', async () => {
  assert.deepEqual(await resolvesPublic('nxdomain.example.com', dns({ 'nxdomain.example.com': 'throw' }, { 'nxdomain.example.com': 'throw' }).fn), { ok: true });
  assert.deepEqual(await resolvesPublic('nothing.example.com', dns({}).fn), { ok: true });
  assert.deepEqual(await resolvesPublic('n.example.com', (async () => null as any) as Resolver), { ok: true });
  // one family failing does not hide a private answer in the other
  assert.equal((await resolvesPublic('half.example.com', dns({ 'half.example.com': 'throw' }, { 'half.example.com': ['::1'] }).fn)).ok, false);
  assert.equal((await resolvesPublic('half.example.com', dns({ 'half.example.com': ['10.0.0.1'] }, { 'half.example.com': 'throw' }).fn)).ok, false);
});

test('resolvesPublic: literal IPs are not looked up; without Deno or a resolver it skips (documented residual risk)', async () => {
  const d = dns({});
  assert.deepEqual(await resolvesPublic('8.8.8.8', d.fn), { ok: true });
  assert.deepEqual(await resolvesPublic('[2606:4700:4700::1111]', d.fn), { ok: true });
  assert.deepEqual(d.seen, []);
  assert.equal((globalThis as any).Deno, undefined);
  assert.deepEqual(await resolvesPublic('169-254-169-254.attacker.example'), { ok: true });   // no Deno here: nothing to ask
});

test('safeFetch + resolver: a public-looking name that resolves inward is refused before any fetch', async () => {
  for (const ans of [['169.254.169.254'], ['127.0.0.1'], ['10.0.0.8'], ['93.184.216.34', '192.168.1.1']]) {
    const s = stub(() => html('LEAK'));
    await assert.rejects(() => safeFetch('https://attacker.example.org/x', { fetchImpl: s.fn, resolver: dns({ 'attacker.example.org': ans }).fn }), /refused to fetch that URL: attacker\.example\.org resolves to a private address/);
    assert.equal(s.calls.length, 0);
  }
  const s6 = stub(() => html('LEAK'));
  await assert.rejects(() => safeFetch('https://attacker.example.org/x', { fetchImpl: s6.fn, resolver: dns({}, { 'attacker.example.org': ['64:ff9b::a9fe:a9fe'] }).fn }), /private/);
  assert.equal(s6.calls.length, 0);
});

test('safeFetch + resolver: every redirect hop is re-resolved (a public host redirecting to a name that resolves inward)', async () => {
  const d = dns({ 'good.example.com': ['93.184.216.34'], 'sneaky.example.net': ['169.254.169.254'] });
  const s = stub((u) => (u.startsWith('https://good.example.com') ? redirect('https://sneaky.example.net/steal') : html('LEAK')));
  await assert.rejects(() => safeFetch('https://good.example.com/a', { fetchImpl: s.fn, resolver: d.fn }), /refused to fetch a redirect: sneaky\.example\.net resolves to a private address/);
  assert.deepEqual(s.calls.map((c) => c.url), ['https://good.example.com/a']);
  assert.ok(d.seen.includes('A:sneaky.example.net'));
  // and a clean chain goes through, resolving each host
  const d2 = dns({ 'good.example.com': ['93.184.216.34'], 'other.example.org': ['93.184.216.35'] });
  const s2 = stub((u) => (u.startsWith('https://good.example.com') ? redirect('https://other.example.org/z') : html('fine')));
  const r = await safeFetch('https://good.example.com/a', { fetchImpl: s2.fn, resolver: d2.fn });
  assert.equal(r.url, 'https://other.example.org/z');
  assert.ok(d2.seen.includes('A:good.example.com') && d2.seen.includes('A:other.example.org'));
});

test('safeFetch: a literal-IP URL never reaches the resolver; allowPrivate skips DNS (admin LAN names)', async () => {
  const d = dns({});
  const s = stub(() => html('ok'));
  await safeFetch('https://8.8.8.8/', { fetchImpl: s.fn, resolver: d.fn });
  assert.deepEqual(d.seen, []);
  const d2 = dns({ 'nas.lan': ['192.168.1.5'] });
  await safeFetch('http://nas.lan:8080/', { fetchImpl: s.fn, resolver: d2.fn, allowHttp: true, allowPrivate: true });
  assert.deepEqual(d2.seen, []);
});

test('GAP: generic DNS rebinding (an attacker domain whose A record flips between our lookup and the connection) cannot be closed here', { todo: 'resolvesPublic resolves, then fetch resolves AGAIN: a TTL-0 record can answer public to us and 169.254.169.254 to the connect. Outside Deno resolveDns is skipped altogether. Real fix: connect to the vetted IP (Deno.createHttpClient + dial) or rely on edge egress rules' }, async () => {
  let n = 0;
  const flip: Resolver = async (_h, t) => (t === 'A' ? [n++ === 0 ? '93.184.216.34' : '169.254.169.254'] : []);
  const s = stub(() => html('ok'));
  // our lookup says public, the later (second) lookup the real connect would do says metadata
  await safeFetch('https://rebind.attacker.example/', { fetchImpl: s.fn, resolver: flip });
  assert.ok(n >= 1);
  assert.fail('safeFetch performed the request after a single lookup; the connect-time answer is unchecked');
});

// ------------------------------------------------------------------ 301/302/303 method downgrade
test('safeFetch: 301/302/303 turn POST into GET and drop the body; 307/308 keep both', async () => {
  for (const code of [301, 302, 303]) {
    const s = stub((u) => (u.endsWith('/a') ? redirect('https://example.com/b', code) : html('ok')));
    await safeFetch('https://example.com/a', { fetchImpl: s.fn, method: 'POST', body: 'q=secret', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(s.calls[0].init.method, 'POST', String(code));
    assert.equal(s.calls[0].init.body, 'q=secret');
    assert.equal(s.calls[1].init.method, 'GET', String(code));
    assert.equal(s.calls[1].init.body, undefined, String(code));
    assert.equal(s.calls[1].init.redirect, 'manual');
  }
  for (const code of [307, 308]) {
    const s = stub((u) => (u.endsWith('/a') ? redirect('https://example.com/b', code) : html('ok')));
    await safeFetch('https://example.com/a', { fetchImpl: s.fn, method: 'POST', body: 'q=1' });
    assert.equal(s.calls[1].init.method, 'POST', String(code));
    assert.equal(s.calls[1].init.body, 'q=1');
  }
});

test('safeFetch: once downgraded to GET the method stays GET through a later 307; a plain GET stays GET', async () => {
  const s = stub((u) => (u.endsWith('/a') ? redirect('/b', 302) : u.endsWith('/b') ? redirect('/c', 307) : html('ok')));
  await safeFetch('https://example.com/a', { fetchImpl: s.fn, method: 'POST', body: 'x=1' });
  assert.deepEqual(s.calls.map((c) => c.init.method), ['POST', 'GET', 'GET']);
  assert.deepEqual(s.calls.map((c) => c.init.body), ['x=1', undefined, undefined]);
  const g = stub((u) => (u.endsWith('/a') ? redirect('/b', 303) : html('ok')));
  await safeFetch('https://example.com/a', { fetchImpl: g.fn });
  assert.deepEqual(g.calls.map((c) => c.init.method ?? 'GET'), ['GET', 'GET']);
});

test('safeFetch: an unparseable Location is refused with a clear message', async () => {
  for (const loc of ['http://[bad', 'https://']) {
    const s = stub(() => redirect(loc));
    await assert.rejects(() => safeFetch('https://example.com/x', { fetchImpl: s.fn }), /Location header is not a valid URL|refused/, loc);
    assert.equal(s.calls.length, 1);
  }
});

// ------------------------------------------------------------------ readCapped
const streamOf = (chunks: Uint8Array[], onCancel?: () => void) => {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) { if (i < chunks.length) c.enqueue(chunks[i++]); else c.close(); },
    cancel() { onCancel?.(); },
  });
};

test('readCapped: reads small bodies completely, including multi-byte UTF-8 split across chunks', async () => {
  const bytes = new TextEncoder().encode('héllo 中文 😀 end');
  const mid = 3;   // splits the two-byte e-acute? and later characters
  const r = new Response(streamOf([bytes.slice(0, mid), bytes.slice(mid, mid + 5), bytes.slice(mid + 5)]));
  assert.equal(await readCapped(r, 1_000_000), 'héllo 中文 😀 end');
  assert.equal(await readCapped(new Response(''), 100), '');
});

test('readCapped: stops pulling and cancels the stream once the cap is reached, however large the body', async () => {
  let pulled = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) { pulled++; c.enqueue(new Uint8Array(1_000_000).fill(0x61)); },   // endless 1 MB chunks
    cancel() { cancelled = true; },
  });
  const out = await readCapped(new Response(stream), 2_500_000);
  assert.equal(out.length, 2_500_000);
  assert.ok(pulled <= 5, `pulled ${pulled} chunks`);
  assert.equal(cancelled, true);
  // exact boundary
  assert.equal((await readCapped(new Response(streamOf([new Uint8Array(10).fill(0x62)])), 10)).length, 10);
  assert.equal((await readCapped(new Response(streamOf([new Uint8Array(10).fill(0x62)])), 4)).length, 4);
  assert.equal(await readCapped(new Response(streamOf([new Uint8Array(10).fill(0x62)])), 0), '');
});

test('readCapped: a cap that cuts a multi-byte character yields a replacement char, not an exception', async () => {
  const bytes = new TextEncoder().encode('ab中');           // 'ab' + 3 bytes
  const out = await readCapped(new Response(streamOf([bytes])), 4);
  assert.equal(out.slice(0, 2), 'ab');
  assert.doesNotThrow(() => out);
});

test('readCapped: falls back to text() for a body that is not a stream', async () => {
  const fake = { body: null, text: async () => 'x'.repeat(50) } as unknown as Response;
  assert.equal((await readCapped(fake, 10)).length, 10);
});

test('webFetchPage: an endless body is cut at MAX_BODY_BYTES instead of being buffered', async () => {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(new TextEncoder().encode('<p>' + 'word '.repeat(200_000) + '</p>')); } });
  const s = stub(() => new Response(stream, { headers: { 'content-type': 'text/html' } }));
  const r = await webFetchPage(envOf({}, {}, s.fn), READ);
  assert.equal(r.page!.text.length, WEB_DEFAULTS.PAGE_CHAR_CAP);
  assert.ok(pulled <= 4, `pulled ${pulled} x 1 MB`);
});

// ------------------------------------------------------------------ cutElements / cutComments
test('cutElements: removes whole elements, case-insensitively, keeping the text around them', () => {
  assert.equal(cutElements('a<script>x()</script>b', ['script']).replace(/\s+/g, ''), 'ab');
  assert.equal(cutElements('a<SCRIPT type="x">x()</SCRIPT >b', ['script']).replace(/\s+/g, ''), 'ab');
  assert.equal(cutElements('a<script>1</script>b<script>2</script>c', ['script']).replace(/\s+/g, ''), 'abc');
  assert.equal(cutElements('<style>p{}</style>t<svg><g/></svg>u', ['style', 'svg']).replace(/\s+/g, ''), 'tu');
  assert.equal(cutElements('no tags here', ['script']), 'no tags here');
  assert.equal(cutElements('', ['script']), '');
});

test('cutElements: a longer tag name that merely starts with the tag is kept; self-closing has no content to skip', () => {
  assert.match(cutElements('<scriptfoo>keep</scriptfoo>', ['script']), /keep/);
  assert.match(cutElements('<stylesheet>keep</stylesheet>', ['style']), /keep/);
  assert.equal(cutElements('a<embed src="x"/>b', ['embed']).replace(/\s+/g, ''), 'ab');
  assert.match(cutElements('a<script src="x"/>visible', ['script']), /visible/);
});

test('cutElements: unclosed / truncated elements drop the rest instead of leaking script source; never throws', () => {
  assert.equal(cutElements('keep<script>secret()', ['script']), 'keep');
  assert.equal(cutElements('keep<script', ['script']), 'keep');
  assert.equal(cutElements('keep<script src="x', ['script']), 'keep');
  for (const junk of ['<', '<<<<', '</script>', '<script>', '<script></script', '<!--<script>', '\u0000<script>\u0000']) assert.doesNotThrow(() => cutElements(junk, ['script', 'style']), junk);
});

test('cutElements: adversarial openers run in linear time', () => {
  for (const unit of ['<script>', '<script ', '<script>x</script', '<style>', '<svg>']) {
    const big = unit.repeat(Math.ceil(400_000 / unit.length));
    const t0 = Date.now();
    cutElements(big, ['script', 'style', 'svg']);
    assert.ok(Date.now() - t0 < 500, `${unit} x ${big.length} took ${Date.now() - t0} ms`);
  }
});

test('cutComments: removes comments, keeps the rest, drops an unterminated tail, linear time', () => {
  assert.equal(cutComments('a<!-- x -->b').replace(/\s+/g, ''), 'ab');
  assert.equal(cutComments('a<!-- x -->b<!-- y -->c').replace(/\s+/g, ''), 'abc');
  assert.equal(cutComments('a<!-- <p>hidden</p> -->b').replace(/\s+/g, ''), 'ab');
  assert.equal(cutComments('keep<!-- never closed <p>secret</p>'), 'keep ');
  assert.equal(cutComments('plain'), 'plain');
  assert.equal(cutComments(''), '');
  const t0 = Date.now();
  cutComments('<!--'.repeat(100_000));
  assert.ok(Date.now() - t0 < 500, `took ${Date.now() - t0} ms`);
});

test('htmlToText: hostile large inputs finish quickly (unclosed script / comment / title / h1 floods) and the input is capped', () => {
  const floods = ['<script>', '<!--', '<title>', '<h2 class=x>', '<style ', '<li>', '&#x', '&amp'];
  for (const unit of floods) {
    const big = unit.repeat(Math.ceil(2_000_000 / unit.length));
    const t0 = Date.now();
    htmlToText(big);
    assert.ok(Date.now() - t0 < 1500, `${unit} flood (2 MB) took ${Date.now() - t0} ms`);
  }
  assert.equal(MAX_HTML_CHARS, 400_000);
  const page = '<p>early marker</p>' + '<p>' + 'filler '.repeat(100_000) + '</p>' + '<p>late marker</p>';
  const { text } = htmlToText(page);
  assert.match(text, /early marker/);
  assert.ok(!/late marker/.test(text), 'text beyond MAX_HTML_CHARS must not be read');
});

test('htmlToText: a page of unterminated tag openers (no ">" anywhere) is cheap', { todo: 'HIGH: /<[^>]+>/g (html.ts:116), and the [^>]* in the li/br/td/h regexes (html.ts:109-114), rescan to EOF from every < when the page has no ">". Measured: 50 KB of < = 6.2 s, <p = 2.8 s, <br = 2.2 s, <td = 1.8 s; the 400 KB cap puts a hostile page at about 3 minutes (189 s measured for <p at 2 MB input). Fix: tokenise with indexOf (find <, then the next >; if none, stop) instead of these regexes' }, () => {
  for (const unit of ['<', '<p', '<br', '<td']) {
    const t0 = Date.now();
    htmlToText(unit.repeat(Math.ceil(50_000 / unit.length)));
    assert.ok(Date.now() - t0 < 500, ` x 50 KB took ${Date.now() - t0} ms`);
  }
});

test('htmlToText: an unclosed <h1> flood is cheap', { todo: 'heading regex {0,2000} bound still costs ~1.6 s on a 400 KB page of <h1> openers (html.ts:109); cap it at {0,200} or scan with indexOf' }, () => {
  const t0 = Date.now();
  htmlToText('<h1>'.repeat(100_000));
  assert.ok(Date.now() - t0 < 500, `took ${Date.now() - t0} ms`);
});

test('searxngSearch with a LAN instance: v4-mapped IPv6 base URL / redirect to loopback or metadata is refused', { todo: 'same bug as the allowPrivate v4-mapped test (guard.ts:200)' }, async () => {
  const s = stub(() => json({ results: [] }));
  await assert.rejects(() => searxngSearch({ query: 'q' }, { baseUrl: 'http://[::ffff:127.0.0.1]:8080', fetchImpl: s.fn, allowHttp: true }), /refused/);
  const s2 = stub((u) => (u.startsWith('http://192.168.1.20') ? redirect('http://[::ffff:169.254.169.254]/') : html('LEAK')));
  await assert.rejects(() => searxngSearch({ query: 'q' }, { baseUrl: 'http://192.168.1.20:8080', fetchImpl: s2.fn, allowHttp: true }), /refused/);
});

test('htmlToText: form / header / nav / footer / aside content is kept; script and style are not', () => {
  const { text } = htmlToText('<form id="aspnetForm"><header><h1>Article Title</h1></header><nav>menu words</nav><div><p>Body paragraph text.</p></div><aside>side note</aside><footer>foot note</footer></form><script>evil()</script>');
  for (const w of ['Article Title', 'Body paragraph text', 'menu words', 'side note', 'foot note']) assert.match(text, new RegExp(w));
  assert.ok(!/evil/.test(text));
  assert.match(htmlToText('<title>T</title><body>x</body>').title!, /^T$/);
  assert.equal(htmlToText('<title>never closed <p>body text</p>').title, null);
});

// ------------------------------------------------------------------ webFetchPage pre-guard with a Tavily key
test('webFetchPage: with a Tavily key, a refused URL makes ZERO requests (Tavily included) and says why', async () => {
  for (const u of ['http://169.254.169.254/latest/meta-data/', 'https://169.254.169.254.nip.io/', 'https://localhost/', 'https://10.0.0.1/', 'file:///etc/passwd', 'javascript:alert(1)', 'https://user:pw@example.com/', 'https://example.com:6379/', 'https://[::ffff:127.0.0.1]/', 'https://[64:ff9b::a9fe:a9fe]/', 'not a url']) {
    const s = stub(() => json({ results: [{ url: 'x', raw_content: 'LEAK' }] }));
    const r = await webFetchPage(envOf({}, { tavily: 'k' }, s.fn), u);
    assert.equal(r.page, null, u);
    assert.match(r.error!, /^refused to fetch that URL: /, u);
    assert.deepEqual(r.usage, [], u);
    assert.equal(s.calls.length, 0, u);
  }
});

// ------------------------------------------------------------------ config / merge regression after the fixes
test('fixed behaviours stay fixed: mergeHits(max<=0), webConfig clamps/dedupes, canonicalUrl keeps ports and sorts params', () => {
  const h = hit('https://a.com/1', 'x');
  for (const m of [0, -1, NaN, -Infinity]) assert.deepEqual(mergeHits([[h]], m), [], String(m));
  assert.equal(webConfig({ web_max_results: 0.5 }).maxResults, 1);
  assert.equal(webConfig({ web_max_results: 1.9 }).maxResults, 1);
  assert.deepEqual(webConfig({ web_providers: ['tavily', 'searxng', 'tavily'] }).providers, ['tavily', 'searxng']);
  assert.equal(canonicalUrl('https://example.com:443/a'), canonicalUrl('https://example.com/a'));
  assert.equal(canonicalUrl('http://example.com:80/a'), canonicalUrl('https://example.com/a'));
  assert.notEqual(canonicalUrl('https://example.com:8443/a'), canonicalUrl('https://example.com/a'));
  assert.equal(canonicalUrl('https://e.com/p?b=2&a=1&utm_source=x'), canonicalUrl('https://e.com/p?a=1&b=2'));
  assert.equal(canonicalUrl('https://e.com/p?mc_cid=1&mc_eid=2&id=5'), canonicalUrl('https://e.com/p?id=5'));
  assert.notEqual(canonicalUrl('https://e.com/p?id=5'), canonicalUrl('https://e.com/p?id=6'));
});
