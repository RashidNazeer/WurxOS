/**
 * Renders rich-text content. Detects HTML and uses dangerouslySetInnerHTML
 * so saved RichTextEditor output renders correctly. Falls back to a
 * pre-wrapped plain-text div for legacy non-HTML strings. Anchor tags
 * get target=_blank and safe rel attrs added on render so legacy links
 * (saved without them) still open externally.
 */

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

export default function RichContent({ html, style, className }) {
  if (html == null || html === '') return null;
  if (isHtml(html)) {
    return (
      <div
        className={`rich-content ${className || ''}`}
        style={style}
        dangerouslySetInnerHTML={{ __html: ensureLinkAttrs(html) }}
      />
    );
  }
  return (
    <div className={className} style={{ whiteSpace: 'pre-wrap', ...(style || {}) }}>
      {html}
    </div>
  );
}
