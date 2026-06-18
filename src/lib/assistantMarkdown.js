// Renders the AI assistant's reply (lightweight markdown) to SAFE HTML.
//
// The assistant emits markdown — bold, italic, inline code, headings,
// numbered/bulleted lists, and links. Crucially it links to in-app paths
// like [Leave](/leave); those are marked with data-nav so the chat can
// intercept the click and navigate via React Router (SPA, no reload).
// External http(s) links open in a new tab. Everything is escaped first,
// then run through DOMPurify — the reply is model output, so we never
// trust it as raw HTML.
import DOMPurify from 'dompurify';

const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Inline spans within a single line. Order matters: links → bold → italic →
// code (bold before italic so ** isn't eaten by the single-* rule).
function inline(text) {
  let t = escapeHtml(text);

  // [label](url) — internal (/path) navigates in-app; http(s) opens external;
  // anything else keeps just the label (no link).
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, url) => {
    if (url.startsWith('/')) return `<a href="${url}" data-nav="${url}" class="ai-link">${label}</a>`;
    if (/^https?:\/\//i.test(url)) return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="ai-link">${label}</a>`;
    return label;
  });

  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>');
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  return t;
}

export function renderAssistantHtml(raw) {
  const lines = String(raw || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let listType = null; // 'ul' | 'ol'
  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };

  for (const line of lines) {
    const heading = line.match(/^\s*#{1,6}\s+(.*)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);

    if (heading) { closeList(); out.push(`<div class="ai-h">${inline(heading[1])}</div>`); continue; }
    if (ordered) {
      if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
      out.push(`<li>${inline(ordered[1])}</li>`); continue;
    }
    if (bullet) {
      if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
      out.push(`<li>${inline(bullet[1])}</li>`); continue;
    }
    closeList();
    if (line.trim() === '') { out.push('<div class="ai-sp"></div>'); continue; }
    out.push(`<div>${inline(line)}</div>`);
  }
  closeList();

  return DOMPurify.sanitize(out.join(''), {
    ALLOWED_TAGS: ['a', 'strong', 'em', 'code', 'ul', 'ol', 'li', 'div', 'span', 'br', 'p'],
    ALLOWED_ATTR: ['href', 'target', 'rel', 'class', 'data-nav'],
  });
}
