// Renders the AI assistant's reply (Markdown) to SAFE HTML.
//
// markdownToHtml (markdownCore.js) does the GFM rendering with `marked`:
// tables, fenced code with a Copy button, task lists, links (in-app /path →
// data-nav for React Router; http(s) → new tab; anything else → text).
// DOMPurify then sanitises with a tight allow-list: the reply is model
// output, so it is never trusted as raw HTML (raw HTML is already escaped
// by the renderer; this is the second net).
import DOMPurify from 'dompurify';
import { markdownToHtml } from './markdownCore';

const ALLOWED_TAGS = [
  'a', 'strong', 'em', 'del', 'code', 'pre', 'p', 'br', 'hr', 'blockquote', 'div', 'span',
  'ul', 'ol', 'li', 'input', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'button',
];
const ALLOWED_ATTR = ['href', 'target', 'rel', 'class', 'data-nav', 'type', 'aria-label', 'align', 'checked', 'disabled', 'start'];

// Task-list checkboxes are the only <input> we keep, and they stay read-only.
DOMPurify.addHook?.('afterSanitizeAttributes', (node) => {
  if (node.nodeName === 'INPUT') {
    if (node.getAttribute('type') !== 'checkbox') { node.remove(); return; }
    node.setAttribute('disabled', '');
  }
  if (node.nodeName === 'BUTTON' && !node.classList.contains('ai-code-copy')) node.remove();
});

// While a reply streams, every message re-renders on each delta; caching by
// text means only the growing one is parsed again (no flicker or CPU storm).
const cache = new Map();
const CACHE_MAX = 300;

export function renderAssistantHtml(raw) {
  const key = String(raw ?? '');
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const html = DOMPurify.sanitize(markdownToHtml(key), { ALLOWED_TAGS, ALLOWED_ATTR });
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, html);
  return html;
}
