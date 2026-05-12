/**
 * Renders rich-text content. Detects HTML and uses dangerouslySetInnerHTML
 * so saved RichTextEditor output renders correctly. Falls back to a
 * pre-wrapped plain-text div for legacy non-HTML strings. Anchor tags
 * get target=_blank and safe rel attrs added on render so legacy links
 * (saved without them) still open externally.
 *
 * All HTML is run through DOMPurify before render — anyone with write
 * access to a brand, KB article, chat message, broadcast, or report
 * section could otherwise stash a stored-XSS payload that fires for
 * every reader (e.g. <img src=x onerror=fetch(...)>). DOMPurify strips
 * <script>, inline event handlers, dangerous protocols, etc.
 */
import DOMPurify from 'dompurify';

const HTML_TAG_RE = /<(p|br|ul|ol|li|strong|em|b|i|u|a|h[1-6]|div|span|blockquote|s|strike|mark)\b/i;

export function isHtml(s) {
  return typeof s === 'string' && HTML_TAG_RE.test(s);
}

function ensureLinkAttrs(html) {
  if (typeof html !== 'string') return html;
  return html.replace(/<a\b([^>]*)>/gi, (_match, attrs) => {
    let out = attrs || '';
    if (!/\btarget\s*=/i.test(out)) out += ' target="_blank"';
    if (!/\brel\s*=/i.test(out))    out += ' rel="noopener noreferrer"';
    return `<a${out}>`;
  });
}

// Single chokepoint for "render this user-saved HTML safely" — used
// by RichContent, BrandSectionsPanel, HighlightableContent, and any
// future component that needs to render arbitrary HTML.
//   * runs DOMPurify
//   * keeps our anchor target/rel patching
//   * preserves `target` + `rel` (DOMPurify strips them by default)
export function sanitizeRichHtml(html) {
  if (typeof html !== 'string') return '';
  // Patch anchors FIRST so target/rel attrs exist when DOMPurify
  // sees them. ADD_ATTR keeps them.
  const patched = ensureLinkAttrs(html);
  // DOMPurify strips comments by default in this config, but being
  // explicit here means callers don't have to worry about leftover
  // Word/Docs clipboard markers like <!--EndFragment-->.
  return DOMPurify.sanitize(patched, {
    ADD_ATTR: ['target', 'rel'],
    ADD_DATA_URI_TAGS: [],
  }).replace(/<!--[\s\S]*?-->/g, '');
}

// Word / Google-Docs clipboard leaves <!--StartFragment--> and
// <!--EndFragment--> markers behind. DOMPurify strips them in HTML mode,
// but the plain-text fallback below would render them as visible text.
// Also catches stray <!-- ... --> from any other source.
function stripHtmlComments(s) {
  return typeof s === 'string' ? s.replace(/<!--[\s\S]*?-->/g, '') : s;
}

export default function RichContent({ html, style, className }) {
  if (html == null || html === '') return null;
  const cleaned = stripHtmlComments(html);
  if (!cleaned) return null;
  if (isHtml(cleaned)) {
    return (
      <div
        className={`rich-content ${className || ''}`}
        style={style}
        dangerouslySetInnerHTML={{ __html: sanitizeRichHtml(cleaned) }}
      />
    );
  }
  return (
    <div className={className} style={{ whiteSpace: 'pre-wrap', ...(style || {}) }}>
      {cleaned}
    </div>
  );
}
