// Buddy's Markdown → HTML, without sanitising (assistantMarkdown.js runs
// DOMPurify on top). Plain module, so scripts/buddy-tests.mjs runs it in Node.
//
// GFM via `marked`: tables, fenced code, task lists, strikethrough, autolinks.
// Model output is never trusted as HTML: raw HTML comes out as escaped text
// (and DOMPurify would strip it anyway). Links keep the old rules:
//   /path    → in-app link (data-nav, React Router); //host is NOT in-app
//   http(s)  → new tab, rel=noopener noreferrer
//   other    → the link text only
// Images are not loaded: their alt text is shown.
import { Marked } from 'marked';

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// A table cell that is a number, money or a percentage → right-aligned.
const NUMERIC = /^\s*[-+(]?\s*(?:[$€£₹]|PKR|Rs\.?|USD)?\s*[-+]?\d[\d,]*(?:\.\d+)?\s*(?:%|[kKmMbB]|x)?\)?\s*$/;

const marked = new Marked({
  gfm: true,
  breaks: true,           // a single newline is a line break, as the chat always showed it
  async: false,
  renderer: {
    html({ text }) { return esc(text); },
    image({ text }) { return esc(text || ''); },
    link({ href, tokens }) {
      const label = this.parser.parseInline(tokens);
      const u = String(href || '');
      if (u.startsWith('/') && !u.startsWith('//')) return `<a href="${esc(u)}" data-nav="${esc(u)}" class="ai-link">${label}</a>`;
      if (/^https?:\/\//i.test(u)) return `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer" class="ai-link">${label}</a>`;
      return label;
    },
    code({ text, lang }) {
      const l = String(lang || '').trim().split(/\s+/)[0];
      return `<div class="ai-code"><button type="button" class="ai-code-copy" aria-label="Copy code">Copy</button>`
        + `<pre><code${l ? ` class="language-${esc(l)}"` : ''}>${esc(text)}</code></pre></div>`;
    },
  },
  hooks: {
    postprocess(html) {
      return html
        // Tables scroll sideways inside the bubble.
        .replace(/<table>/g, '<div class="ai-table"><table>').replace(/<\/table>/g, '</table></div>')
        // Numeric cells right-aligned.
        .replace(/<td( align="[a-z]+")?>([^<]*)<\/td>/g, (m, align, inner) => (
          !align && NUMERIC.test(inner.replace(/&amp;/g, '&')) ? `<td class="is-num">${inner}</td>` : m));
    },
  },
});

export function markdownToHtml(raw) {
  const src = String(raw ?? '').replace(/\r\n/g, '\n');
  if (!src.trim()) return '';
  try {
    return marked.parse(src);
  } catch {
    // Never break the chat over a parse error (e.g. odd partial input mid-stream).
    return `<p>${esc(src).replace(/\n/g, '<br>')}</p>`;
  }
}
