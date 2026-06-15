import { useEffect } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import { buildExtensions } from './richTextKit';
import HighlighterPicker, { useHighlightStyle } from './HighlighterPicker';

/**
 * Production rich-text editor built on TipTap (ProseMirror). Replaces the
 * legacy contentEditable/execCommand editor — gains a real document model,
 * so backspace/Enter/list-exit/paste/keyboard shortcuts all behave reliably.
 *
 * Public API is UNCHANGED ({ value(HTML), onChange(html), readOnly, minHeight,
 * placeholder }) so every consumer (report forms, portal custom sections,
 * legacy report form) keeps working, and existing stored HTML round-trips
 * losslessly via the custom marks below:
 *   • RhHighlight → <mark class="rh" data-color data-intensity> (same as v1;
 *     reports.css + report views render it identically).
 *   • FontSize    → <span style="font-size:Npx"> on the textStyle mark.
 */

const FONT_SIZES = ['10', '11', '12', '14', '16', '18', '20', '24', '28', '32', '36', '48', '72'];

const BTN = {
  background: 'transparent', border: '1px solid transparent', borderRadius: 6,
  padding: '4px 8px', fontSize: 13, cursor: 'pointer', color: 'var(--text-primary)',
  minWidth: 30, height: 30, display: 'inline-flex', alignItems: 'center',
  justifyContent: 'center', fontWeight: 700, fontFamily: 'inherit', lineHeight: 1,
};
const BTN_ACTIVE = { background: 'var(--accent-soft)', borderColor: 'color-mix(in srgb, var(--accent) 45%, transparent)', color: 'var(--accent)' };

function Tb({ onClick, active, title, children, style }) {
  return (
    <button type="button" title={title}
      onMouseDown={(e) => { e.preventDefault(); onClick(); }}
      style={{ ...BTN, ...(active ? BTN_ACTIVE : null), ...style }}>
      {children}
    </button>
  );
}
function Divider() {
  return <span style={{ width: 1, height: 22, background: 'var(--border-default)', margin: '0 3px' }} />;
}

const HEADINGS = [
  { v: 'p',  label: 'Normal' },
  { v: '1',  label: 'Heading 1' },
  { v: '2',  label: 'Heading 2' },
  { v: '3',  label: 'Heading 3' },
  { v: '4',  label: 'Heading 4' },
];

export default function RichTextEditor({
  value = '',
  onChange,
  readOnly = false,
  minHeight = 200,
  placeholder = 'Start typing…',
}) {
  const {
    color: hColor, setColor: setHColor,
    intensity: hIntensity, setIntensity: setHIntensity,
  } = useHighlightStyle();

  const editor = useEditor({
    editable: !readOnly,
    extensions: buildExtensions(placeholder),
    content: value || '',
    editorProps: {
      attributes: { class: 'rte-surface', style: `min-height:${minHeight}px` },
      // Strip pasted fonts/colors so content adopts the app's typography
      // (matches the v1 paste sanitiser intent). mark.rh uses data-attrs, not
      // style, so highlights survive.
      transformPastedHTML: (html) => String(html)
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\s(?:font-size|font-family|color|background|background-color|line-height|letter-spacing)\s*:\s*[^;"']+;?/gi, ''),
    },
    onUpdate: ({ editor }) => onChange?.(editor.isEmpty ? '' : editor.getHTML()),
  });

  // External value → editor (async data load, or a programmatic reset).
  // Skip while focused so we never clobber the user mid-type.
  useEffect(() => {
    if (!editor) return;
    const incoming = value || '';
    if (!editor.isFocused && incoming !== (editor.isEmpty ? '' : editor.getHTML())) {
      editor.commands.setContent(incoming, false);
    }
  }, [value, editor]);

  useEffect(() => {
    if (editor) editor.setEditable(!readOnly);
  }, [readOnly, editor]);

  if (!editor) return null;

  const headingValue = HEADINGS.slice(1).find((h) => editor.isActive('heading', { level: Number(h.v) }))?.v || 'p';

  function setHeading(v) {
    const c = editor.chain().focus();
    if (v === 'p') c.setParagraph().run();
    else c.toggleHeading({ level: Number(v) }).run();
  }
  function handleLink() {
    const prev = editor.getAttributes('link').href || '';
    const url = window.prompt('Link URL (leave empty to remove):', prev || 'https://');
    if (url === null) return;
    if (url.trim() === '') { editor.chain().focus().extendMarkRange('link').unsetLink().run(); return; }
    const href = url.trim();
    if (editor.state.selection.empty && !editor.isActive('link')) {
      editor.chain().focus().insertContent(`<a href="${href.replace(/"/g, '&quot;')}">${href.replace(/</g, '&lt;')}</a> `).run();
    } else {
      editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
    }
  }

  return (
    <div style={{ border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', overflow: 'hidden', background: 'var(--surface-1)' }}>
      {!readOnly && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 3, padding: 6, background: 'var(--surface-2)', borderBottom: '1px solid var(--border-subtle)' }}>
          <Tb title="Bold (Ctrl+B)" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}>B</Tb>
          <Tb title="Italic (Ctrl+I)" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()} style={{ fontStyle: 'italic' }}>I</Tb>
          <Tb title="Underline (Ctrl+U)" active={editor.isActive('underline')} onClick={() => editor.chain().focus().toggleUnderline().run()} style={{ textDecoration: 'underline' }}>U</Tb>
          <Tb title="Strikethrough" active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()} style={{ textDecoration: 'line-through' }}>S</Tb>
          <Divider />
          <select value={headingValue} onChange={(e) => setHeading(e.target.value)} title="Paragraph style"
            style={{ background: 'var(--surface-1)', border: '1px solid var(--border-default)', borderRadius: 6, padding: '2px 6px', fontSize: 12, cursor: 'pointer', color: 'var(--text-primary)', height: 30 }}>
            {HEADINGS.map((h) => <option key={h.v} value={h.v}>{h.label}</option>)}
          </select>
          <select value="" onChange={(e) => { if (e.target.value) editor.chain().focus().setFontSize(`${e.target.value}px`).run(); }} title="Font size (px)"
            style={{ background: 'var(--surface-1)', border: '1px solid var(--border-default)', borderRadius: 6, padding: '2px 6px', fontSize: 12, cursor: 'pointer', color: 'var(--text-primary)', height: 30 }}>
            <option value="">Size</option>
            {FONT_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <Divider />
          <Tb title="Bulleted list" active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()}>•</Tb>
          <Tb title="Numbered list" active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()}>1.</Tb>
          <Tb title="Checklist" active={editor.isActive('taskList')} onClick={() => editor.chain().focus().toggleTaskList().run()}>☑</Tb>
          <Divider />
          <Tb title="Align left" active={editor.isActive({ textAlign: 'left' })} onClick={() => editor.chain().focus().setTextAlign('left').run()}>⇤</Tb>
          <Tb title="Align center" active={editor.isActive({ textAlign: 'center' })} onClick={() => editor.chain().focus().setTextAlign('center').run()}>↔</Tb>
          <Tb title="Align right" active={editor.isActive({ textAlign: 'right' })} onClick={() => editor.chain().focus().setTextAlign('right').run()}>⇥</Tb>
          <Tb title="Justify" active={editor.isActive({ textAlign: 'justify' })} onClick={() => editor.chain().focus().setTextAlign('justify').run()}>≣</Tb>
          <Divider />
          <Tb title="Quote" active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()}>❝</Tb>
          <Tb title="Code block" active={editor.isActive('codeBlock')} onClick={() => editor.chain().focus().toggleCodeBlock().run()} style={{ fontFamily: 'var(--font-mono)' }}>{'</>'}</Tb>
          <Tb title="Divider" onClick={() => editor.chain().focus().setHorizontalRule().run()}>―</Tb>
          <Tb title="Insert / edit link" active={editor.isActive('link')} onClick={handleLink}>🔗</Tb>
          <Divider />
          <Tb title="Highlight selection" active={editor.isActive('rhHighlight')}
            onClick={() => editor.chain().focus().toggleRhHighlight({ color: hColor, intensity: hIntensity }).run()}>✏︎</Tb>
          <HighlighterPicker color={hColor} onColorChange={setHColor} intensity={hIntensity} onIntensityChange={setHIntensity} compact />
          <Tb title="Clear formatting" onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}>⌫</Tb>
          <Divider />
          <Tb title="Undo (Ctrl+Z)" onClick={() => editor.chain().focus().undo().run()}>↶</Tb>
          <Tb title="Redo (Ctrl+Y)" onClick={() => editor.chain().focus().redo().run()}>↷</Tb>
        </div>
      )}

      <EditorContent editor={editor} />

      <style>{`
        .rte-surface { padding: 12px 14px; font-size: 13.5px; line-height: 1.6; outline: none; color: var(--text-primary); word-break: break-word; }
        .rte-surface:focus { outline: none; }
        .rte-surface > * { margin: 0 0 0.55rem; }
        .rte-surface > *:last-child { margin-bottom: 0; }
        .rte-surface h1 { font-size: 1.5rem;  font-weight: 700; }
        .rte-surface h2 { font-size: 1.25rem; font-weight: 700; }
        .rte-surface h3 { font-size: 1.08rem; font-weight: 600; }
        .rte-surface h4 { font-size: 0.96rem; font-weight: 600; }
        .rte-surface ul, .rte-surface ol { padding-left: 1.5rem; }
        .rte-surface ul[data-type='taskList'] { list-style: none; padding-left: 0.25rem; }
        .rte-surface ul[data-type='taskList'] li { display: flex; gap: 0.5rem; align-items: flex-start; }
        .rte-surface ul[data-type='taskList'] li > label { margin-top: 0.2rem; }
        .rte-surface ul[data-type='taskList'] input[type='checkbox'] { accent-color: var(--accent); }
        .rte-surface a { color: var(--accent); text-decoration: underline; cursor: pointer; }
        .rte-surface blockquote { border-left: 3px solid var(--border-strong); padding-left: 0.9rem; color: var(--text-secondary); }
        .rte-surface pre { background: var(--surface-2); border: 1px solid var(--border-subtle); border-radius: 8px; padding: 10px 12px; font-family: var(--font-mono); font-size: 0.85em; overflow-x: auto; }
        .rte-surface code { font-family: var(--font-mono); }
        .rte-surface hr { border: none; border-top: 1px solid var(--border-default); margin: 0.8rem 0; }
        .rte-surface p.is-editor-empty:first-child::before { content: attr(data-placeholder); color: var(--text-muted); float: left; height: 0; pointer-events: none; }

        /* Highlighter — identical to the report views (reports.css mark.rh) */
        .rte-surface mark.rh { padding: 0 1px; border-radius: 2px; color: #1f2937; }
        .rte-surface mark.rh[data-color='yellow'][data-intensity='light']  { background: #fef9c3; }
        .rte-surface mark.rh[data-color='yellow'][data-intensity='medium'] { background: #fef08a; }
        .rte-surface mark.rh[data-color='yellow'][data-intensity='dark']   { background: #fde047; }
        .rte-surface mark.rh[data-color='green'][data-intensity='light']   { background: #dcfce7; }
        .rte-surface mark.rh[data-color='green'][data-intensity='medium']  { background: #bbf7d0; }
        .rte-surface mark.rh[data-color='green'][data-intensity='dark']    { background: #86efac; }
        .rte-surface mark.rh[data-color='pink'][data-intensity='light']    { background: #fce7f3; }
        .rte-surface mark.rh[data-color='pink'][data-intensity='medium']   { background: #f9a8d4; }
        .rte-surface mark.rh[data-color='pink'][data-intensity='dark']     { background: #f472b6; }
        .rte-surface mark.rh[data-color='blue'][data-intensity='light']    { background: #dbeafe; }
        .rte-surface mark.rh[data-color='blue'][data-intensity='medium']   { background: #93c5fd; }
        .rte-surface mark.rh[data-color='blue'][data-intensity='dark']     { background: #60a5fa; }
        .rte-surface mark.rh[data-color='orange'][data-intensity='light']  { background: #ffedd5; }
        .rte-surface mark.rh[data-color='orange'][data-intensity='medium'] { background: #fdba74; }
        .rte-surface mark.rh[data-color='orange'][data-intensity='dark']   { background: #fb923c; }
      `}</style>
    </div>
  );
}
