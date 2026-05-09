import { useEffect, useRef, useState } from 'react';
import HighlighterPicker, { useHighlightStyle } from './HighlighterPicker';

/**
 * Lightweight contentEditable-based rich-text editor — Word-like toolbar.
 * Zero external deps. Emits HTML via onChange(html).
 *
 * Supports: bold, italic, underline, strikethrough, font-size, ordered/
 * unordered lists, alignment, link, indent/outdent, highlight (with
 * color/intensity picker), clear-all-formatting, undo/redo.
 *
 * Paste sanitizer strips font-family / font-size / colors so pasted Word /
 * Google Docs / Outlook content adopts the app's font.
 */

const BTN_STYLE = {
  background: 'transparent',
  border: '1px solid transparent',
  borderRadius: 6,
  padding: '4px 8px',
  fontSize: 13,
  cursor: 'pointer',
  color: 'var(--text-primary)',
  minWidth: 28,
  height: 28,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontWeight: 700,
  fontFamily: 'inherit',
};

const FONT_SIZES = ['8', '9', '10', '11', '12', '14', '16', '18', '20', '24', '28', '32', '36', '48', '72'];

function ToolbarButton({ glyph, title, onMouseDown, italic, underline, strike }) {
  const styleExtras = italic ? { fontStyle: 'italic' }
    : underline ? { textDecoration: 'underline' }
    : strike    ? { textDecoration: 'line-through' }
    : null;
  return (
    <button type="button" title={title}
      onMouseDown={onMouseDown}
      style={{ ...BTN_STYLE, ...styleExtras }}>
      {glyph}
    </button>
  );
}

function Divider() {
  return <span style={{
    display: 'inline-block', width: 1,
    background: 'var(--border-default)',
    alignSelf: 'stretch', margin: '2px 4px',
  }} />;
}

export default function RichTextEditor({
  value = '',
  onChange,
  readOnly = false,
  minHeight = 200,
  placeholder = 'Start typing…',
}) {
  const ref = useRef(null);
  const savedRangeRef = useRef(null);
  const [, force] = useState(0);
  const {
    color: highlightColor, setColor: setHighlightColor,
    intensity: highlightIntensity, setIntensity: setHighlightIntensity,
  } = useHighlightStyle();

  // Initial mount — load html
  useEffect(() => {
    if (ref.current && ref.current.innerHTML !== value) {
      ref.current.innerHTML = value || '';
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync from outside when not focused
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (document.activeElement !== el && el.innerHTML !== (value || '')) {
      el.innerHTML = value || '';
    }
  }, [value]);

  // Track selection for toolbar restore
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const save = () => captureSelection();
    el.addEventListener('keyup', save);
    el.addEventListener('mouseup', save);
    return () => {
      el.removeEventListener('keyup', save);
      el.removeEventListener('mouseup', save);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function captureSelection() {
    const el = ref.current;
    if (!el) return;
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) {
      savedRangeRef.current = sel.getRangeAt(0).cloneRange();
    }
  }

  function restoreSelection() {
    const el = ref.current;
    if (!el) return;
    el.focus();
    if (!savedRangeRef.current) return;
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(savedRangeRef.current);
  }

  function exec(cmd, val) {
    document.execCommand(cmd, false, val);
    if (ref.current) onChange?.(ref.current.innerHTML);
    force((x) => x + 1);
  }

  function handleInput() {
    if (ref.current) onChange?.(ref.current.innerHTML);
  }

  // Apply font size in pixels — uses execCommand fontSize as a sentinel,
  // then upgrades <font size="7"> wrappers to <span style="font-size: Xpx">.
  function applyFontSize(px) {
    const el = ref.current;
    if (!el || !px) return;
    restoreSelection();
    document.execCommand('fontSize', false, '7');
    el.querySelectorAll('font[size="7"]').forEach((f) => {
      const span = document.createElement('span');
      span.style.fontSize = `${px}px`;
      while (f.firstChild) span.appendChild(f.firstChild);
      f.parentNode.replaceChild(span, f);
    });
    onChange?.(el.innerHTML);
    force((x) => x + 1);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function unwrapNode(node) {
    const parent = node.parentNode;
    if (!parent) return;
    while (node.firstChild) parent.insertBefore(node.firstChild, node);
    parent.removeChild(node);
  }

  function replaceTagWithP(node) {
    const p = document.createElement('p');
    while (node.firstChild) p.appendChild(node.firstChild);
    node.parentNode.replaceChild(p, node);
  }

  function deepStripFormatting(root, range) {
    const FORMAT_TAGS  = ['B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'FONT', 'CODE', 'MARK', 'SMALL', 'BIG', 'SUB', 'SUP'];
    const HEADING_TAGS = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE'];
    const LIST_TAGS    = ['UL', 'OL'];

    const matches = (node) => !range || range.intersectsNode(node);

    HEADING_TAGS.forEach((tag) => {
      Array.from(root.querySelectorAll(tag.toLowerCase())).forEach((n) => {
        if (matches(n)) replaceTagWithP(n);
      });
    });

    LIST_TAGS.forEach((tag) => {
      Array.from(root.querySelectorAll(tag.toLowerCase())).forEach((list) => {
        if (!matches(list)) return;
        Array.from(list.querySelectorAll('li')).forEach((li) => replaceTagWithP(li));
        unwrapNode(list);
      });
    });

    FORMAT_TAGS.forEach((tag) => {
      Array.from(root.querySelectorAll(tag.toLowerCase())).forEach((n) => {
        if (matches(n)) unwrapNode(n);
      });
    });

    Array.from(root.querySelectorAll('span')).forEach((n) => {
      if (matches(n)) unwrapNode(n);
    });

    Array.from(root.querySelectorAll('[style], [class]')).forEach((n) => {
      if (!matches(n)) return;
      n.removeAttribute('style');
      n.removeAttribute('class');
    });
  }

  function clearAllFormatting() {
    const el = ref.current;
    if (!el) return;
    const range = savedRangeRef.current;
    const hasSelection = range && !range.collapsed && el.contains(range.commonAncestorContainer);

    if (!hasSelection) {
      // Full reset — rebuild from plain text to guarantee no leftover styling.
      const text = el.innerText || el.textContent || '';
      const lines = text.split(/\r?\n/);
      const html = lines.some((l) => l.length > 0)
        ? lines.map((l) => `<p>${l ? escapeHtml(l) : '<br>'}</p>`).join('')
        : '';
      el.innerHTML = html;
      savedRangeRef.current = null;
      onChange?.(el.innerHTML);
      force((x) => x + 1);
      return;
    }

    restoreSelection();
    deepStripFormatting(el, range);
    onChange?.(el.innerHTML);
    force((x) => x + 1);
  }

  // Wrap selection in <mark.rh>; if selection overlaps existing marks, remove them.
  function applyEditorHighlight() {
    const el = ref.current;
    if (!el) return;
    restoreSelection();
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    if (!el.contains(range.commonAncestorContainer)) return;

    const marks = Array.from(el.querySelectorAll('mark.rh'));
    const overlapping = marks.filter((m) => range.intersectsNode(m));

    if (overlapping.length > 0) {
      overlapping.forEach((m) => {
        const parent = m.parentNode;
        if (!parent) return;
        while (m.firstChild) parent.insertBefore(m.firstChild, m);
        parent.removeChild(m);
      });
    } else {
      const mark = document.createElement('mark');
      mark.className = 'rh';
      mark.setAttribute('data-color', highlightColor);
      mark.setAttribute('data-intensity', highlightIntensity);
      try {
        range.surroundContents(mark);
      } catch {
        const contents = range.extractContents();
        mark.appendChild(contents);
        range.insertNode(mark);
      }
    }

    el.normalize();
    onChange?.(el.innerHTML);
    force((x) => x + 1);
  }

  function handleLink() {
    const el = ref.current;
    if (!el) return;
    const sel = window.getSelection();
    const hasRange = sel && sel.rangeCount > 0 && el.contains(sel.anchorNode);
    const range = hasRange ? sel.getRangeAt(0).cloneRange() : null;
    const selectedText = range && !range.collapsed ? range.toString() : '';

    const text = window.prompt('Link text:', selectedText || '');
    if (text == null) return;
    const trimmedText = text.trim();
    if (!trimmedText) return;
    const url = window.prompt('Enter URL:', 'https://');
    if (!url) return;

    const esc = trimmedText
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    const href = url.replace(/"/g, '&quot;');
    const anchorHtml = `<a href="${href}" target="_blank" rel="noopener noreferrer">${esc}</a>&nbsp;`;

    el.focus();
    if (range) {
      const curSel = window.getSelection();
      curSel.removeAllRanges();
      curSel.addRange(range);
    }
    document.execCommand('insertHTML', false, anchorHtml);
    onChange?.(el.innerHTML);
    force((x) => x + 1);
  }

  // Sanitize pasted HTML — strip pasted fonts/colors so content adopts app font.
  const STRIP_STYLE_PROPS = new Set([
    'font-family', 'font-size', 'font-weight', 'color',
    'background', 'background-color', 'line-height',
    'letter-spacing', 'word-spacing', 'mso-style-name', 'mso-style-parent',
  ]);

  function sanitizeStyle(style) {
    if (!style) return '';
    return style.split(';')
      .map((s) => s.trim())
      .filter((s) => {
        if (!s) return false;
        const prop = s.split(':')[0].trim().toLowerCase();
        return !STRIP_STYLE_PROPS.has(prop) && !prop.startsWith('mso-');
      })
      .join('; ');
  }

  function sanitizePastedHtml(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    tmp.querySelectorAll('style, meta, link, script, title, o\\:p').forEach((n) => n.remove());
    tmp.querySelectorAll('*').forEach((node) => {
      node.removeAttribute('class');
      node.removeAttribute('lang');
      const cleaned = sanitizeStyle(node.getAttribute('style'));
      if (cleaned) node.setAttribute('style', cleaned);
      else node.removeAttribute('style');
    });
    return tmp.innerHTML;
  }

  function handlePaste(e) {
    const cd = e.clipboardData || window.clipboardData;
    if (!cd) return;
    const html = cd.getData('text/html');
    const text = cd.getData('text/plain');
    e.preventDefault();
    const el = ref.current;
    if (!el) return;
    el.focus();
    if (html) {
      document.execCommand('insertHTML', false, sanitizePastedHtml(html));
    } else if (text) {
      document.execCommand('insertText', false, text);
    }
    onChange?.(el.innerHTML);
    force((x) => x + 1);
  }

  return (
    <div style={{
      border: '1px solid var(--border-default)',
      borderRadius: 'var(--radius-md)',
      overflow: 'hidden',
      background: 'var(--surface-1)',
    }}>
      {!readOnly && (
        <div style={{
          display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4,
          padding: 6,
          background: 'var(--surface-2)',
          borderBottom: '1px solid var(--border-subtle)',
        }}>
          <ToolbarButton glyph="B" title="Bold (Ctrl+B)"
            onMouseDown={(e) => { e.preventDefault(); exec('bold'); }} />
          <ToolbarButton glyph="I" italic title="Italic (Ctrl+I)"
            onMouseDown={(e) => { e.preventDefault(); exec('italic'); }} />
          <ToolbarButton glyph="U" underline title="Underline (Ctrl+U)"
            onMouseDown={(e) => { e.preventDefault(); exec('underline'); }} />
          <ToolbarButton glyph="S" strike title="Strikethrough"
            onMouseDown={(e) => { e.preventDefault(); exec('strikeThrough'); }} />
          <Divider />
          <select
            value=""
            onMouseDown={() => captureSelection()}
            onChange={(e) => { const v = e.target.value; if (v) applyFontSize(v); }}
            title="Font size (in pixels)"
            style={{
              background: 'var(--surface-1)', border: '1px solid var(--border-default)', borderRadius: 6,
              padding: '2px 6px', fontSize: 12, cursor: 'pointer',
              color: 'var(--text-primary)', height: 28,
            }}>
            <option value="">Size</option>
            {FONT_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <Divider />
          <ToolbarButton glyph="•" title="Bulleted list"
            onMouseDown={(e) => { e.preventDefault(); exec('insertUnorderedList'); }} />
          <ToolbarButton glyph="1." title="Numbered list"
            onMouseDown={(e) => { e.preventDefault(); exec('insertOrderedList'); }} />
          <ToolbarButton glyph="←" title="Decrease indent"
            onMouseDown={(e) => { e.preventDefault(); exec('outdent'); }} />
          <ToolbarButton glyph="→" title="Increase indent"
            onMouseDown={(e) => { e.preventDefault(); exec('indent'); }} />
          <Divider />
          <ToolbarButton glyph="⇤" title="Align left"
            onMouseDown={(e) => { e.preventDefault(); exec('justifyLeft'); }} />
          <ToolbarButton glyph="↔" title="Align center"
            onMouseDown={(e) => { e.preventDefault(); exec('justifyCenter'); }} />
          <ToolbarButton glyph="⇥" title="Align right"
            onMouseDown={(e) => { e.preventDefault(); exec('justifyRight'); }} />
          <Divider />
          <button type="button"
            onMouseDown={(e) => { e.preventDefault(); handleLink(); }}
            style={BTN_STYLE} title="Insert link">🔗</button>
          <button type="button"
            onMouseDown={(e) => { e.preventDefault(); applyEditorHighlight(); }}
            style={BTN_STYLE}
            title="Highlight selection (or remove highlight if selection overlaps an existing one)">
            ✏︎
          </button>
          <HighlighterPicker
            color={highlightColor} onColorChange={setHighlightColor}
            intensity={highlightIntensity} onIntensityChange={setHighlightIntensity}
            compact />
          <button type="button"
            onMouseDown={(e) => { e.preventDefault(); clearAllFormatting(); }}
            style={BTN_STYLE}
            title="Clear all formatting (resets to normal text)">
            ⌫
          </button>
          <Divider />
          <button type="button" title="Undo"
            onMouseDown={(e) => { e.preventDefault(); exec('undo'); }}
            style={BTN_STYLE}>↶</button>
          <button type="button" title="Redo"
            onMouseDown={(e) => { e.preventDefault(); exec('redo'); }}
            style={BTN_STYLE}>↷</button>
        </div>
      )}

      <div
        ref={ref}
        contentEditable={!readOnly}
        onInput={handleInput}
        onBlur={handleInput}
        onPaste={handlePaste}
        suppressContentEditableWarning
        className="rich-text-editor-surface"
        data-placeholder={placeholder}
        style={{
          minHeight, padding: '12px 14px', fontSize: 13.5, lineHeight: 1.6,
          outline: 'none', color: 'var(--text-primary)',
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          background: readOnly ? 'var(--surface-2)' : 'var(--surface-1)',
        }}
      />
      <style>{`
        .rich-text-editor-surface:empty:before {
          content: attr(data-placeholder);
          color: var(--text-muted); pointer-events: none;
        }
        .rich-text-editor-surface,
        .rich-text-editor-surface *:not(code):not(pre):not(kbd):not(samp) {
          font-family: inherit !important;
        }
        .rich-text-editor-surface h1 { font-size: 1.5rem; font-weight: 700; margin: 0.6rem 0; }
        .rich-text-editor-surface h2 { font-size: 1.25rem; font-weight: 700; margin: 0.5rem 0; }
        .rich-text-editor-surface h3 { font-size: 1.05rem; font-weight: 600; margin: 0.4rem 0; }
        .rich-text-editor-surface ul, .rich-text-editor-surface ol { padding-left: 1.5rem; }
        .rich-text-editor-surface a { color: var(--accent); text-decoration: underline; }

        /* Highlight marks — same in editor and view */
        mark.rh { padding: 0 1px; border-radius: 2px; }
        mark.rh[data-color='yellow'][data-intensity='light']  { background: #fef9c3; }
        mark.rh[data-color='yellow'][data-intensity='medium'] { background: #fef08a; }
        mark.rh[data-color='yellow'][data-intensity='dark']   { background: #fde047; }
        mark.rh[data-color='green'][data-intensity='light']   { background: #dcfce7; }
        mark.rh[data-color='green'][data-intensity='medium']  { background: #bbf7d0; }
        mark.rh[data-color='green'][data-intensity='dark']    { background: #86efac; }
        mark.rh[data-color='pink'][data-intensity='light']    { background: #fce7f3; }
        mark.rh[data-color='pink'][data-intensity='medium']   { background: #f9a8d4; }
        mark.rh[data-color='pink'][data-intensity='dark']     { background: #f472b6; }
        mark.rh[data-color='blue'][data-intensity='light']    { background: #dbeafe; }
        mark.rh[data-color='blue'][data-intensity='medium']   { background: #93c5fd; }
        mark.rh[data-color='blue'][data-intensity='dark']     { background: #60a5fa; }
        mark.rh[data-color='orange'][data-intensity='light']  { background: #ffedd5; }
        mark.rh[data-color='orange'][data-intensity='medium'] { background: #fdba74; }
        mark.rh[data-color='orange'][data-intensity='dark']   { background: #fb923c; }
      `}</style>
    </div>
  );
}
