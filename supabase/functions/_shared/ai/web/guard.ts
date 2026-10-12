// What Buddy is allowed to fetch from the open internet.
//
// WHY this exists: open_web_page takes a URL chosen by the MODEL, which in turn
// may have read it out of a web page or a retrieved document. That is an
// attacker-influenced URL being fetched by a server that holds the service-role
// key, so without a guard it is a server-side request forgery hole straight at
// Supabase's and the cloud provider's internal endpoints.
//
// Two rules do the work:
//   1. only http(s), no credentials in the URL, no non-public host;
//   2. redirects are followed BY HAND (redirect: 'manual'), re-checking every
//      hop. A public host that 302s to 169.254.169.254 is the usual trick, and
//      fetch's automatic redirect would walk right into it.

export type GuardResult = { ok: true; url: URL } | { ok: false; reason: string };

// Hostnames that mean "this machine" or a cloud metadata service.
const BLOCKED_HOSTS = new Set([
  'localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback',
  'metadata', 'metadata.google.internal', 'metadata.goog',
  'instance-data', 'instance-data.ec2.internal',
  'kubernetes', 'kubernetes.default', 'kubernetes.default.svc',
]);
// Internal-only TLDs (RFC 6762 / 8375 and the usual private conventions), plus
// the public wildcard-DNS services whose whole purpose is to resolve an
// arbitrary (usually private) IP from the hostname. Those are the standard way
// to walk past a host-string SSRF check, so the services themselves are out.
const BLOCKED_SUFFIX = [
  '.localhost', '.local', '.internal', '.home.arpa', '.cluster.local', '.svc', '.lan', '.intranet', '.corp',
  '.nip.io', '.sslip.io', '.xip.io', '.traefik.me', '.localtest.me', '.lvh.me', '.vcap.me', '.localho.st',
];
const BLOCKED_EXACT_DOMAINS = new Set(['nip.io', 'sslip.io', 'xip.io', 'localtest.me', 'lvh.me', 'vcap.me', 'traefik.me']);

// A hostname that CONTAINS a private IPv4, dotted or dashed:
// 169.254.169.254.nip.io, 127-0-0-1.sslip.io. A string check cannot catch every
// name that resolves inward (that is what resolvesPublic is for), but these
// spellings are the common, free, no-setup route and are worth refusing outright.
export function embeddedPrivateIp(host: string): boolean {
  for (const m of host.matchAll(/(\d{1,3})[.-](\d{1,3})[.-](\d{1,3})[.-](\d{1,3})/g)) {
    const o = [m[1], m[2], m[3], m[4]].map((p) => Number(p));
    if (o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) continue;
    if (isPrivateIpv4(o)) return true;
  }
  return false;
}

const dec = (s: string) => {
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 && n <= 255 ? n : null;
};

// An IPv4 literal → its four octets. Rejects the sneaky spellings (octal
// 0177.0.0.1, a bare 32-bit integer 2130706433) by only accepting plain
// decimal dotted quads; anything else that parses as a number is treated as an
// IP we refuse to reason about.
export function ipv4Octets(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || (p.length > 1 && p.startsWith('0'))) return null;
    const n = dec(p);
    if (n === null) return null;
    out.push(n);
  }
  return out;
}

export function isPrivateIpv4(o: number[]): boolean {
  const [a, b] = o;
  if (a === 0) return true;                       // 0.0.0.0/8 "this network"
  if (a === 10) return true;                      // private
  if (a === 127) return true;                     // loopback
  if (a === 169 && b === 254) return true;        // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;          // 192.0.0.0/24 protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true;  // carrier NAT
  if (a === 198 && (b === 18 || b === 19)) return true;  // benchmarking
  if (a >= 224) return true;                      // multicast + reserved + broadcast
  return false;
}

// An IPv6 literal → its 16 bytes. Handles "::" compression and a trailing
// dotted-quad (::ffff:127.0.0.1). Null when it is not parseable as IPv6.
export function ipv6Bytes(host: string): number[] | null {
  let h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (!h || !h.includes(':')) return null;
  h = h.replace(/%[^\]]*$/, '');                  // drop a zone id
  // A trailing IPv4 becomes two groups.
  const v4 = h.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) {
    const o = ipv4Octets(v4[1]);
    if (!o) return null;
    h = h.slice(0, -v4[1].length)
      + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = h.split('::');
  if (halves.length > 2) return null;
  const parse = (s: string): number[] | null => {
    if (!s) return [];
    const out: number[] = [];
    for (const g of s.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      const n = parseInt(g, 16);
      out.push((n >> 8) & 0xff, n & 0xff);
    }
    return out;
  };
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if (!head || !tail) return null;
  if (halves.length === 2) {
    const fill = 16 - head.length - tail.length;
    if (fill < 0) return null;
    return [...head, ...Array(fill).fill(0), ...tail];
  }
  return head.length === 16 ? head : null;
}

// IPv6 that must never be fetched.
//
// The obvious ones are loopback, link-local and unique-local. The subtle ones
// are the transition formats, which all carry an IPv4 address INSIDE an IPv6
// address, so a v6 literal can smuggle in 169.254.169.254 and reach the cloud
// metadata service wherever the host network translates them. QA found these
// getting through a string-prefix check: ::7f00:1 (IPv4-compatible 127.0.0.1),
// 64:ff9b::a9fe:a9fe (NAT64), 2002:a9fe:a9fe::1 (6to4) and ff02::1 (multicast).
export function isPrivateIpv6(host: string): boolean {
  const b = ipv6Bytes(host);
  if (!b) {
    // Unparseable: refuse rather than guess.
    return true;
  }
  const zeros = (n: number) => b.slice(0, n).every((x) => x === 0);
  if (zeros(16)) return true;                                   // ::
  if (zeros(15) && b[15] === 1) return true;                    // ::1 loopback
  if (b[0] === 0xff) return true;                               // ff00::/8 multicast
  if ((b[0] === 0xfe) && (b[1] & 0xc0) === 0x80) return true;    // fe80::/10 link-local
  if ((b[0] & 0xfe) === 0xfc) return true;                       // fc00::/7 unique-local
  // ::ffff:a.b.c.d (v4-mapped) and ::a.b.c.d (v4-compatible): judge the IPv4.
  if (zeros(10) && b[10] === 0xff && b[11] === 0xff) return isPrivateIpv4(b.slice(12));
  if (zeros(12)) return true;                                   // ::x.x.x.x — deprecated, always refused
  // 64:ff9b::/96 NAT64 and 64:ff9b:1::/48 local-use NAT64.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return isPrivateIpv4(b.slice(12));
  // 2002::/16 6to4 carries the IPv4 in bytes 2-5.
  if (b[0] === 0x20 && b[1] === 0x02) return isPrivateIpv4(b.slice(2, 6));
  return false;
}

// Ports that are never a public web server. A public host is still a host we
// should not be port-scanning through Buddy.
const BLOCKED_PORTS = new Set([
  22, 23, 25, 53, 69, 110, 111, 135, 137, 138, 139, 143, 161, 389, 445, 465, 587, 636,
  873, 993, 995, 1433, 1521, 2049, 2375, 2376, 3306, 3389, 4444, 5432, 5672, 5900, 5984,
  6379, 7001, 8020, 9000, 9042, 9200, 9300, 11211, 15672, 27017, 27018, 50070,
]);

export type CheckOpts = {
  allowHttp?: boolean;
  // Only for a host an ADMIN typed into settings (the company's own SearXNG on
  // the LAN). Never set for a URL that came from the model or from a web page.
  allowPrivate?: boolean;
};

// One URL, checked. `allowHttp` is false by default: plain http would let a
// network-level attacker rewrite the page Buddy then quotes as a source.
export function checkUrl(raw: string, opts: CheckOpts = {}): GuardResult {
  let url: URL;
  try { url = new URL(String(raw).trim()); } catch { return { ok: false, reason: 'not a valid URL' }; }
  const scheme = url.protocol.toLowerCase();
  if (scheme !== 'https:' && scheme !== 'http:') return { ok: false, reason: `only http(s) URLs are allowed, not ${scheme.replace(':', '')}` };
  if (scheme === 'http:' && !opts.allowHttp) return { ok: false, reason: 'only https URLs are allowed' };
  if (url.username || url.password) return { ok: false, reason: 'URLs with credentials are not allowed' };
  if (url.port && BLOCKED_PORTS.has(Number(url.port))) return { ok: false, reason: `port ${url.port} is not a web port` };
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return { ok: false, reason: 'no host in the URL' };

  const isIpv6Literal = /^\[/.test(url.host) || (host.includes(':') && !host.includes('.'));
  const o = isIpv6Literal ? null : ipv4Octets(host);
  const numericish = !isIpv6Literal && !o && /^[0-9.]+$/.test(host);

  // Refused even for an ADMIN-typed host (allowPrivate), because no legitimate
  // SearXNG lives at any of these and the damage if one did is severe:
  //   • loopback / "this machine" — the edge function's own process;
  //   • 169.254.0.0/16 link-local — the AWS/GCP instance metadata service,
  //     which hands out cloud credentials to anything that asks. Assistant
  //     settings are writable by the Boss AND every active developer, so
  //     "an admin typed it" is not a strong enough reason to allow it;
  //   • multicast and reserved space.
  const alwaysOff = BLOCKED_HOSTS.has(host)
    || (o ? (o[0] === 127 || o[0] === 0 || (o[0] === 169 && o[1] === 254) || o[0] >= 224) : false)
    || (isIpv6Literal && (() => {
      const b = ipv6Bytes(host);
      if (!b) return true;
      if (b.slice(0, 15).every((x) => x === 0) && (b[15] === 1 || b[15] === 0)) return true;   // ::, ::1
      if (b[0] === 0xff) return true;                                                          // multicast
      if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true;                                 // link-local
      // Every transition format that can carry 169.254.169.254 inside.
      // ::ffff:0:0/96 (v4-MAPPED) was missing here, so with allowPrivate on,
      // http://[::ffff:169.254.169.254]/ reached the metadata service — QA
      // caught it. It is the most common of these spellings, being the one the
      // IPv6 stack itself produces for an IPv4 destination.
      const zeros10 = b.slice(0, 10).every((x) => x === 0);
      const embedded = (zeros10 && b[10] === 0xff && b[11] === 0xff) ? b.slice(12)   // ::ffff:a.b.c.d
        : b.slice(0, 12).every((x) => x === 0) ? b.slice(12)                          // ::a.b.c.d
          : (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) ? b.slice(12)   // 64:ff9b::/96
            : (b[0] === 0x20 && b[1] === 0x02) ? b.slice(2, 6) : null;                // 2002::/16
      return !!embedded && (embedded[0] === 127 || embedded[0] === 0 || (embedded[0] === 169 && embedded[1] === 254) || embedded[0] >= 224);
    })());
  // Worded by what it is, so the message tells an admin why: a literal address
  // is "private", a name is "internal".
  if (alwaysOff) return { ok: false, reason: (o || isIpv6Literal) ? 'that address is private' : 'that host is internal' };
  // A name that spells out a private address (nip.io and friends).
  if (!o && !isIpv6Literal && (BLOCKED_EXACT_DOMAINS.has(host) || embeddedPrivateIp(host))) {
    return { ok: false, reason: 'that host resolves to a private address' };
  }

  if (!opts.allowPrivate) {
    if (BLOCKED_SUFFIX.some((s) => host.endsWith(s))) return { ok: false, reason: 'that host is internal' };
    // A host with no dot cannot be a public DNS name (it is a container or alias).
    if (!host.includes('.') && !isIpv6Literal) return { ok: false, reason: 'that host is internal' };
    if (isIpv6Literal && isPrivateIpv6(host)) return { ok: false, reason: 'that address is private' };
    if (o && isPrivateIpv4(o)) return { ok: false, reason: 'that address is private' };
    // Numeric-looking host that is not a clean dotted quad: an obfuscated IP.
    if (numericish) return { ok: false, reason: 'that address is not allowed' };
  } else if (isIpv6Literal && !ipv6Bytes(host)) {
    return { ok: false, reason: 'that address is not a valid IPv6 address' };
  } else if (numericish) {
    return { ok: false, reason: 'that address is not allowed' };
  }
  return { ok: true, url };
}

// ── DNS ────────────────────────────────────────────────────────────────────
// checkUrl only reads the host STRING, so a perfectly public-looking name whose
// A record points inside (169-254-169-254.nip.io, 127.0.0.1.sslip.io,
// localtest.me, or any attacker domain) sails past it. QA found this and it is
// the one hole that string checks cannot close, so the host is resolved and
// every answer is judged before we connect.
//
// Deno.resolveDns is the only resolver available in the edge runtime. Where it
// is missing (the Node test runner, a local script) resolution is SKIPPED
// rather than failing closed, because the alternative is that browsing simply
// does not work outside Deno. That is recorded as the accepted residual risk:
// a DNS-rebinding attacker who wins the race between our lookup and the
// connection is still possible, and the runtime's egress rules are the backstop.
export async function resolvesPublic(host: string, resolver?: (h: string, t: 'A' | 'AAAA') => Promise<string[]>,
  opts: { allowRfc1918?: boolean } = {}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const resolve = resolver ?? (globalThis as any).Deno?.resolveDns;
  if (!resolve) return { ok: true };
  // A literal IP was already judged by checkUrl.
  if (ipv4Octets(host) || host.includes(':')) return { ok: true };
  const lookup = async (type: 'A' | 'AAAA'): Promise<string[]> => {
    try { return (await resolve(host, type)) ?? []; } catch { return []; }
  };
  const [v4, v6] = await Promise.all([lookup('A'), lookup('AAAA')]);
  if (!v4.length && !v6.length) return { ok: true };   // nothing resolved: let fetch report it
  // With allowRfc1918 (an admin-configured LAN host) a 10/172.16/192.168
  // answer is fine, but loopback, link-local/metadata and multicast never are.
  const badV4 = (o: number[] | null) => {
    if (!o) return true;
    if (o[0] === 127 || o[0] === 0 || (o[0] === 169 && o[1] === 254) || o[0] >= 224) return true;
    return opts.allowRfc1918 ? false : isPrivateIpv4(o);
  };
  for (const a of v4) if (badV4(ipv4Octets(a))) return { ok: false, reason: `${host} resolves to an address we will not fetch` };
  for (const a of v6) {
    const b = ipv6Bytes(a);
    const hardNo = !b || (b.slice(0, 15).every((x) => x === 0) && b[15] <= 1) || b[0] === 0xff || (b[0] === 0xfe && (b[1] & 0xc0) === 0x80);
    if (hardNo || (!opts.allowRfc1918 && isPrivateIpv6(a))) return { ok: false, reason: `${host} resolves to an address we will not fetch` };
  }
  return { ok: true };
}

export const MAX_REDIRECTS = 4;

// Headers that authenticate us and must never cross an origin boundary.
const CREDENTIAL_HEADERS = new Set(['authorization', 'x-subscription-token', 'x-api-key', 'api-key', 'cookie', 'proxy-authorization']);

export function stripCredentialHeaders(h: HeadersInit | undefined): HeadersInit | undefined {
  if (!h) return h;
  const entries: [string, string][] = h instanceof Headers ? [...h.entries()]
    : Array.isArray(h) ? h.map(([k, v]) => [String(k), String(v)] as [string, string])
      : Object.entries(h as Record<string, string>).map(([k, v]) => [k, String(v)] as [string, string]);
  return entries.filter(([k]) => !CREDENTIAL_HEADERS.has(k.toLowerCase()));
}

// fetch with every redirect hop re-checked against checkUrl AND re-resolved.
export async function safeFetch(raw: string, init: RequestInit & {
  fetchImpl?: typeof fetch; allowHttp?: boolean; allowPrivate?: boolean;
  resolver?: (h: string, t: 'A' | 'AAAA') => Promise<string[]>;
} = {}): Promise<{ res: Response; url: string }> {
  const { fetchImpl = fetch, allowHttp, allowPrivate, resolver, ...rest } = init;
  let target = raw;
  let method = (rest as RequestInit).method ?? 'GET';
  let body = (rest as RequestInit).body;
  let headers = (rest as RequestInit).headers;
  let origin: string | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // allowPrivate covers ONLY the URL an admin configured — the first hop.
    // A LAN SearXNG that redirects onward gets no such trust, or one
    // compromised instance could walk us around the whole internal network
    // (QA: a 302 to 10.x or .internal was being followed).
    const trusted = allowPrivate && hop === 0;
    const g = checkUrl(target, { allowHttp, allowPrivate: trusted });
    if (!g.ok) throw new Error(`refused to fetch ${hop ? 'a redirect' : 'that URL'}: ${g.reason}`);
    // A credential belongs to ONE origin. If a redirect crosses origins, the
    // api keys come off before we follow it, or a provider that redirected
    // (today none do, but the endpoint is not ours to guarantee) would hand
    // Brave's X-Subscription-Token or Tavily's bearer token to another host.
    if (origin && origin !== g.url.origin) headers = stripCredentialHeaders(headers);
    origin = g.url.origin;
    // An admin-typed LAN host is allowed to resolve to RFC1918 space — that is
    // the point of allowPrivate — but NOT to loopback, link-local/metadata or
    // multicast. Otherwise `http://x.attacker.example` with an A record of
    // 169.254.169.254 walks in through the SearXNG setting (QA F5).
    const dns = trusted
      ? await resolvesPublic(g.url.hostname, resolver, { allowRfc1918: true })
      : await resolvesPublic(g.url.hostname, resolver);
    if (!dns.ok) throw new Error(`refused to fetch ${hop ? 'a redirect' : 'that URL'}: ${dns.reason}`);
    const res = await fetchImpl(g.url.toString(), { ...rest, headers, method, body, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return { res, url: g.url.toString() };
      try { await res.body?.cancel(); } catch { /* already drained */ }
      let next: string;
      // A Location we cannot even parse is refused, not quietly treated as the
      // end of the chain: we would otherwise hand back a 3xx as if it were the
      // page, and the caller would read an empty body as content.
      try { next = new URL(loc, g.url).toString(); } catch { throw new Error(`refused to fetch a redirect: its Location header is not a valid URL`); }
      // Browsers turn 301/302/303 into a GET and drop the body; matching that
      // keeps us from re-POSTing a SearXNG query to wherever it points.
      if (res.status === 301 || res.status === 302 || res.status === 303) { method = 'GET'; body = undefined; }
      target = next;
      continue;
    }
    return { res, url: g.url.toString() };
  }
  throw new Error(`too many redirects (more than ${MAX_REDIRECTS})`);
}
