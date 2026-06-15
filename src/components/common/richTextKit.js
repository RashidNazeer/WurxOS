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
    TaskList,
    TaskItem.configure({ nested: true }),
    Placeholder.configure({ placeholder }),
  ];
}
