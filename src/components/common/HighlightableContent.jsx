import { useEffect, useRef, useState } from 'react';
import { isHtml } from './RichContent';
import { setReportHighlight, getReportHighlight } from '../../lib/reportHighlightsApi';

/**
 * Renders rich-content HTML with persistent text-highlight support.
 *
 * UX: parent passes `highlighterActive` (bool). When true, the cursor
 * changes inside this content area; any text the user selects is auto-
 * highlighted on mouseup (or unhighlighted, if the selection overlaps
 * an existing mark). Highlights are saved to data.highlights[fieldKey]
 * on the report row so other viewers see them too.
 */

function ensureLinkAttrs(html) {
  if (typeof html !== 'string') return html;
  return html.replace(/<a\b([^>]*)>/gi, (_match, attrs) => {
    let out = attrs || '';
    if (!/\btarget\s*=/i.test(out)) out += ' target="_blank"';
    if (!/\brel\s*=/i.test(out))    out += ' rel="noopener noreferrer"';
    return `<a${out}>`;
  });
}

// Compute the start/end offsets of `range` relative to the plain-text
// content of `container`. Survives DOM mutations from browser extensions.
function getTextOffsets(container, range) {
  let startOffset = 0, endOffset = 0;
  let foundStart = false, foundEnd = false;
  function walk(node) {
    if (foundStart && foundEnd) return;
    if (node.nodeType === Node.TEXT_NODE) {
      if (!foundStart) {
        if (node === range.startContainer) {
          startOffset += range.startOffset;
          foundStart = true;
        } else {
          startOffset += node.length;
        }
      }
      if (!foundEnd) {
        if (node === range.endContainer) {
          endOffset += range.endOffset;
          foundEnd = true;
        } else {
          endOffset += node.length;
        }
      }
      return;
    }
    for (let i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i]);
  }
  walk(container);
  if (!foundStart || !foundEnd) return null;
  if (startOffset === endOffset) return null;
  return { startOffset, endOffset };
}

function rangeFromTextOffsets(container, startOffset, endOffset) {
  let charsSeen = 0;
  let startNode = null, startNodeOffset = 0;
  let endNode   = null, endNodeOffset   = 0;
  function walk(node) {
    if (startNode && endNode) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const len = node.length;
      if (!startNode && charsSeen + len >= startOffset) {
        startNode = node;
        startNodeOffset = Math.max(0, startOffset - charsSeen);
      }
      if (!endNode && charsSeen + len >= endOffset) {
        endNode = node;
        endNodeOffset = Math.max(0, endOffset - charsSeen);
      }
      charsSeen += len;
      return;
    }
    for (let i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i]);
  }
  walk(container);
  if (!startNode || !endNode) return null;
  try {
    const range = document.createRange();
    range.setStart(startNode, startNodeOffset);
    range.setEnd(endNode, endNodeOffset);
    return range;
  } catch { return null; }
}

function wrapSelectionWithMark(range, root, opts = {}) {
  const color     = opts.color     || 'yellow';
  const intensity = opts.intensity || 'medium';
  const walkerRoot = range.commonAncestorContainer.nodeType === 1
    ? range.commonAncestorContainer
    : range.commonAncestorContainer.parentNode;
  if (!walkerRoot) return;

  const walker = document.createTreeWalker(walkerRoot, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      if (!range.intersectsNode(node)) return NodeFilter.FILTER_REJECT;
      if (node.nodeValue.length === 0) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const textNodes = [];
  let n;
  while ((n = walker.nextNode())) textNodes.push(n);

  textNodes.forEach((tn) => {
    const parent = tn.parentNode;
    if (!parent) return;
    if (parent.tagName === 'MARK' && parent.classList.contains('rh')) return;

    const startOffset = tn === range.startContainer ? range.startOffset : 0;
    const endOffset   = tn === range.endContainer   ? range.endOffset   : tn.length;
    if (startOffset >= endOffset) return;

    const before = tn.nodeValue.slice(0, startOffset);
    const middle = tn.nodeValue.slice(startOffset, endOffset);
    const after  = tn.nodeValue.slice(endOffset);

    const mark = document.createElement('mark');
    mark.className = 'rh';
    mark.setAttribute('data-color', color);
    mark.setAttribute('data-intensity', intensity);
    mark.textContent = middle;

    const fragment = document.createDocumentFragment();
    if (before) fragment.appendChild(document.createTextNode(before));
    fragment.appendChild(mark);
    if (after)  fragment.appendChild(document.createTextNode(after));
    parent.replaceChild(fragment, tn);
  });

  if (root && typeof root.normalize === 'function') root.normalize();
}

function unwrapMarksInSelection(range, root) {
  const marks = Array.from(root.querySelectorAll('mark.rh'));
  marks.forEach((m) => {
    if (range.intersectsNode(m)) {
      const parent = m.parentNode;
      if (!parent) return;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
    }
  });
  if (root && typeof root.normalize === 'function') root.normalize();
}

export default function HighlightableContent({
  html: rawHtml, report, fieldKey, style, className,
  highlighterActive = false,
  highlightColor = 'yellow', highlightIntensity = 'medium',
}) {
  const containerRef = useRef(null);
  const [displayHtml, setDisplayHtml] = useState(
    () => getReportHighlight(report, fieldKey) || rawHtml || '',
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDisplayHtml(getReportHighlight(report, fieldKey) || rawHtml || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawHtml, report?.id, fieldKey, report?.data?.highlights?.[fieldKey]]);

  useEffect(() => {
    if (!highlighterActive) return undefined;

    async function handleMouseUp() {
      await new Promise((r) => setTimeout(r, 0));
      const c = containerRef.current;
      if (!c) return;

      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;

      let range = sel.getRangeAt(0);
      if (!c.contains(range.commonAncestorContainer)) return;
      if (!sel.toString().trim()) return;

      const offsets = getTextOffsets(c, range);
      const safeRange = (range && c.contains(range.commonAncestorContainer))
        ? range
        : (offsets ? rangeFromTextOffsets(c, offsets.startOffset, offsets.endOffset) : null);
      if (!safeRange) return;

      let mode = 'add';
      const marks = c.querySelectorAll('mark.rh');
      for (const m of marks) {
        if (safeRange.intersectsNode(m)) { mode = 'remove'; break; }
      }

      try {
        if (mode === 'add') wrapSelectionWithMark(safeRange, c, { color: highlightColor, intensity: highlightIntensity });
        else                unwrapMarksInSelection(safeRange, c);
      } catch (err) {
        console.error('[HighlightableContent] mark/unmark failed:', err);
        return;
      }

      const newHtml = c.innerHTML;
      setDisplayHtml(newHtml);
      sel.removeAllRanges();

      if (!report?.id) return;
      setBusy(true);
      try {
        await setReportHighlight(report.id, fieldKey, newHtml);
        // Mutate in-place so subsequent reads see the change without
        // waiting for query refetch.
        report.data = report.data || {};
        report.data.highlights = { ...(report.data.highlights || {}), [fieldKey]: newHtml };
      } catch (err) {
        console.error('[HighlightableContent] save failed:', err);
      } finally {
        setBusy(false);
      }
    }

    document.addEventListener('mouseup', handleMouseUp);
    return () => document.removeEventListener('mouseup', handleMouseUp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlighterActive, report?.id, fieldKey, highlightColor, highlightIntensity]);

  if (displayHtml == null || displayHtml === '') return null;

  const escapeForHtml = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const renderedHtml = isHtml(displayHtml)
    ? ensureLinkAttrs(displayHtml)
    : `<p>${escapeForHtml(displayHtml).replace(/\r?\n/g, '<br>')}</p>`;

  return (
    <div
      ref={containerRef}
      className={`rich-content highlightable-content ${highlighterActive ? 'highlighter-active' : ''} ${className || ''}`}
      style={{
        ...(style || {}),
        cursor: highlighterActive ? 'text' : undefined,
      }}
      data-busy={busy ? '1' : undefined}
      title={highlighterActive ? 'Drag across text to highlight (drag across a highlight to remove it)' : undefined}
      dangerouslySetInnerHTML={{ __html: renderedHtml }}
    />
  );
}
