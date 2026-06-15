// TipTap extension kit for the WurxOS rich-text editor.
//
// Kept framework-agnostic (no React / no JSX) so it can be imported by the
// editor component AND by a headless round-trip test that guarantees existing
// stored report HTML survives the editor losslessly.
//
// Two custom marks preserve the legacy serialization exactly:
//   • RhHighlight → <mark class="rh" data-color data-intensity>  (also styled
//     by reports.css + the report views — must stay byte-compatible).
//   • FontSize    → font-size on the textStyle mark (<span style="font-size:Npx">).

import { Mark, Extension, mergeAttributes } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import TextAlign from '@tiptap/extension-text-align';
import TextStyle from '@tiptap/extension-text-style';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Placeholder from '@tiptap/extension-placeholder';

export const FontSize = Extension.create({
  name: 'fontSize',
  addOptions() { return { types: ['textStyle'] }; },
  addGlobalAttributes() {
    return [{
      types: this.options.types,
      attributes: {
        fontSize: {
          default: null,
          // Read el.style first (browser), fall back to parsing the raw style
          // attribute (robust in any DOM impl, incl. headless serializers).
          parseHTML: (el) => {
            const v = el.style && el.style.fontSize;
            if (v) return v;
            const m = /font-size:\s*([^;]+)/i.exec((el.getAttribute && el.getAttribute('style')) || '');
            return m ? m[1].trim() : null;
          },
          renderHTML: (attrs) => (attrs.fontSize ? { style: `font-size: ${attrs.fontSize}` } : {}),
        },
      },
    }];
  },
  addCommands() {
    return {
      setFontSize: (size) => ({ chain }) => chain().setMark('textStyle', { fontSize: size }).run(),
      unsetFontSize: () => ({ chain }) => chain().setMark('textStyle', { fontSize: null }).removeEmptyTextStyle().run(),
    };
  },
});

export const RhHighlight = Mark.create({
  name: 'rhHighlight',
  addAttributes() {
    return {
      color:     { default: 'yellow', parseHTML: (el) => el.getAttribute('data-color') || 'yellow', renderHTML: (a) => ({ 'data-color': a.color }) },
      intensity: { default: 'medium', parseHTML: (el) => el.getAttribute('data-intensity') || 'medium', renderHTML: (a) => ({ 'data-intensity': a.intensity }) },
    };
  },
  parseHTML() { return [{ tag: 'mark' }]; },
  renderHTML({ HTMLAttributes }) { return ['mark', mergeAttributes({ class: 'rh' }, HTMLAttributes), 0]; },
  addCommands() {
    return {
      toggleRhHighlight: (attrs) => ({ commands }) => commands.toggleMark('rhHighlight', attrs),
      unsetRhHighlight:  () => ({ commands }) => commands.unsetMark('rhHighlight'),
    };
  },
});

// Paragraph / heading indentation (the "add margin from the left" control).
// Stored as an inline margin-left so it round-trips through getHTML AND renders
// identically in the report views: DOMPurify keeps margin-left, and an inline
// style beats the `.rich-content p { margin: … }` reset (same mechanism that
// makes font-size + text-align render in views). Lists are NOT given the attr —
// inside a list, Tab/indent nests the list item natively (handled below), so
// Tab and the toolbar buttons behave the same whether or not you're in a list.
export const Indent = Extension.create({
  name: 'indent',
  addOptions() {
    return {
      blockTypes: ['paragraph', 'heading'],
      listTypes: ['bulletList', 'orderedList', 'taskList'],
      step: 16,
      maxLevel: 16,
    };
  },
  addGlobalAttributes() {
    const { blockTypes, listTypes, step, maxLevel } = this.options;
    return [{
      // Lists carry the indent on the <ul>/<ol> so the WHOLE list shifts as a
      // block; paragraphs/headings carry it themselves.
      types: [...blockTypes, ...listTypes],
      attributes: {
        indent: {
          default: 0,
          // Read el.style first (browser), fall back to parsing the raw style
          // attribute (robust in any DOM impl). margin-left:Npx → level.
          parseHTML: (el) => {
            const raw = (el.style && el.style.marginLeft)
              || (/margin-left:\s*([^;]+)/i.exec((el.getAttribute && el.getAttribute('style')) || '') || [])[1]
              || '';
            const px = parseFloat(raw);
            if (!px || Number.isNaN(px)) return 0;
            return Math.min(maxLevel, Math.max(0, Math.round(px / step)));
          },
          renderHTML: (attrs) => (attrs.indent ? { style: `margin-left: ${attrs.indent * step}px` } : {}),
        },
      },
    }];
  },
  addCommands() {
    const { blockTypes, listTypes, maxLevel } = this.options;
    const clamp = (n) => Math.min(maxLevel, Math.max(0, n));
    const shift = (delta) => ({ state, dispatch }) => {
      const { selection } = state;
      const { $from } = selection;
      // 1) In a list → move the whole NEAREST list left/right by adding margin
      //    to the <ul>/<ol>. Works on every bullet incl. the first (unlike
      //    nesting, which can't sink a first item — that's what looked broken).
      for (let d = $from.depth; d > 0; d--) {
        const node = $from.node(d);
        if (listTypes.includes(node.type.name)) {
          const cur = node.attrs.indent || 0;
          const next = clamp(cur + delta);
          if (next === cur) return false;
          if (dispatch) dispatch(state.tr.setNodeMarkup($from.before(d), undefined, { ...node.attrs, indent: next }));
          return true;
        }
      }
      // 2) Otherwise indent every paragraph/heading in the selection.
      const { from, to } = selection;
      const tr = state.tr;
      let changed = false;
      state.doc.nodesBetween(from, to, (node, pos) => {
        if (!blockTypes.includes(node.type.name)) return;
        const cur = node.attrs.indent || 0;
        const next = clamp(cur + delta);
        if (next !== cur) { tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: next }); changed = true; }
      });
      if (changed && dispatch) dispatch(tr);
      return changed;
    };
    return { indent: () => shift(1), outdent: () => shift(-1) };
  },
  addKeyboardShortcuts() {
    return {
      // Always swallow Tab so focus stays in the editor (except code blocks,
      // which want a literal tab character).
      Tab: () => {
        if (this.editor.isActive('codeBlock')) return false;
        this.editor.commands.indent();
        return true;
      },
      'Shift-Tab': () => {
        if (this.editor.isActive('codeBlock')) return false;
        this.editor.commands.outdent();
        return true;
      },
    };
  },
});

// The full extension set. `placeholder` is editor-only (ignored when headless).
export function buildExtensions(placeholder = '') {
  return [
    StarterKit.configure({ heading: { levels: [1, 2, 3, 4] } }),
    Underline,
    TextStyle,
    FontSize,
    RhHighlight,
    Link.configure({ openOnClick: false, autolink: true, HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer' } }),
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    Indent,
    TaskList,
    TaskItem.configure({ nested: true }),
    Placeholder.configure({ placeholder }),
  ];
}
