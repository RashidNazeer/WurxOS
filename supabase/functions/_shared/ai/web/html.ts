// HTML → readable text, for the fallback path of open_web_page.
//
// Deliberately a small regex reader, not a DOM parser: the edge runtime has no
// DOMParser, and pulling a parser in over the network for every page read is
// not worth it. The job is only to get the prose a model can read, so losing
// layout is fine. Tavily's extractor is the primary path; this is what keeps
// browsing working when Tavily is out of credits or unconfigured.

// Tags whose CONTENT is never prose.
//
// `form`, `header`, `nav`, `footer` and `aside` were here and have been taken
// out: QA found that dropping `form` emptied every ASP.NET WebForms page (the
// whole body sits inside one form) and dropping `header` lost article titles.
// Their boilerplate is handled instead by the short-line filter at the bottom,
// which costs a little noise and never costs the article.
const DROP_TAGS = ['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object', 'embed'];

// How much HTML is worth reading. Beyond this it is a dump, not a page.
export const MAX_HTML_CHARS = 400_000;

// Cut every <tag>…</tag> region out, by scanning. The obvious regex for this
// (`<tag[^>]*>[\s\S]*?</tag>`) is quadratic when the closing tag is missing:
// QA measured 8,000 unclosed <script> openers taking 325 ms and quadrupling
// on every doubling, which on a 2 MB page pins the edge function's CPU for
// minutes. indexOf is linear and cannot backtrack.
export function cutElements(src: string, tags: string[]): string {
  let s = src;
  for (const tag of tags) {
    const open = `<${tag}`;
    const close = `</${tag}`;
    let out = '';
    let i = 0;
    const low = s.toLowerCase();
    for (;;) {
      const start = low.indexOf(open, i);
      // Must be a tag, not a prefix of a longer name (<scriptfoo>).
      if (start < 0) { out += s.slice(i); break; }
      const after = low[start + open.length];
      if (after && !/[\s>/]/.test(after)) { out += s.slice(i, start + open.length); i = start + open.length; continue; }
      out += s.slice(i, start);
      const gt = low.indexOf('>', start);
      if (gt < 0) { break; }                       // truncated opener: drop the rest
      // A self-closing or void spelling has no content to skip.
      if (low[gt - 1] === '/') { out += ' '; i = gt + 1; continue; }
      const end = low.indexOf(close, gt);
      if (end < 0) { break; }                      // never closed: drop the rest
      const endGt = low.indexOf('>', end);
      out += ' ';
      i = endGt < 0 ? s.length : endGt + 1;
    }
    s = out;
  }
  return s;
}

// Comments, the same way and for the same reason.
export function cutComments(src: string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const start = src.indexOf('<!--', i);
    if (start < 0) { out += src.slice(i); break; }
    out += `${src.slice(i, start)} `;
    const end = src.indexOf('-->', start + 4);
    if (end < 0) break;                            // unterminated: drop the rest
    i = end + 3;
  }
  return out;
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', middot: '·',
  times: '×', trade: '™', reg: '®', copy: '©', euro: '€', pound: '£', deg: '°', eacute: 'é',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (m, g: string) => {
    if (g[0] === '#') {
      const code = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[g.toLowerCase()] ?? m;
  });
}

// Block-level tags: their close becomes a line break.
const BLOCK_TAGS = new Set(['p', 'div', 'section', 'article', 'tr', 'ul', 'ol', 'table', 'blockquote', 'pre',
  'header', 'footer', 'nav', 'aside', 'main', 'figure', 'figcaption', 'dl', 'dd', 'dt', 'hr', 'body']);

// One tag → the whitespace or marker it leaves behind.
function tagToText(raw: string): string {
  const closing = raw.charCodeAt(0) === 47;   // '/'
  const m = /^\/?\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(raw);
  if (!m) return ' ';
  const tag = m[1].toLowerCase();
  const h = /^h([1-6])$/.exec(tag);
  if (h) return closing ? '\n\n' : `\n\n${'#'.repeat(Number(h[1]))} `;
  if (tag === 'br') return '\n';
  if (tag === 'li') return closing ? '\n' : '\n- ';
  if (tag === 'td' || tag === 'th') return closing ? '\t' : ' ';
  if (BLOCK_TAGS.has(tag)) return '\n';
  return ' ';
}

// Strip every tag, keeping the structure that matters, in ONE linear pass.
//
// This replaced a stack of regexes (`<[^>]+>`, `<li\b[^>]*>`, the heading
// matcher…). Every one of them was quadratic on input with an unterminated
// '<': QA measured 50 KB of bare "<" characters taking 6.2 seconds, and 400 KB
// of "<p" taking 189 seconds — a hostile page would pin the edge function's
// CPU for minutes. indexOf cannot backtrack, so this is linear whatever the
// input, and a '<' with no closing '>' simply ends the document.
export function stripTags(src: string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { out += src.slice(i); break; }
    out += src.slice(i, lt);
    const gt = src.indexOf('>', lt + 1);
    if (gt < 0) break;                   // unterminated tag: the rest is not markup we can trust
    out += tagToText(src.slice(lt + 1, gt));
    i = gt + 1;
  }
  return out;
}

export function htmlToText(html: string): { title: string | null; text: string } {
  let s = String(html).slice(0, MAX_HTML_CHARS);

  // Bounded on purpose: `<title[^>]*>([\s\S]*?)</title>` over a page with no
  // closing </title> is the same quadratic trap as the element cutter.
  const title = (() => {
    const low = s.toLowerCase();
    const open = low.indexOf('<title');
    if (open < 0) return null;
    const gt = low.indexOf('>', open);
    if (gt < 0) return null;
    const end = low.indexOf('</title', gt);
    if (end < 0) return null;
    return decodeEntities(s.slice(gt + 1, end)).replace(/\s+/g, ' ').trim().slice(0, 300) || null;
  })();

  s = cutComments(s);
  s = cutElements(s, DROP_TAGS);

  s = decodeEntities(stripTags(s));

  // Collapse whitespace but keep paragraph breaks.
  s = s.replace(/\r/g, '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Boilerplate navigation leaves runs of very short lines; drop the worst of it.
  const lines = s.split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) { if (kept[kept.length - 1] !== '') kept.push(''); continue; }
    // A one or two character line is a separator or an icon label.
    if (t.length <= 2 && !/^#+/.test(t)) continue;
    kept.push(t);
  }
  return { title, text: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim() };
}
