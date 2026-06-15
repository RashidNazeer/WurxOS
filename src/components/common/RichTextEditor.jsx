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
 *
 * The toolbar is a pure presentation layer over the engine — icons (Bootstrap
 * Icons), grouped sections, hover/active states, a focus ring and a sticky
 * bar. None of the editor commands changed.
 */

const FONT_SIZES = ['10', '11', '12', '14', '16', '18', '20', '24', '28', '32', '36', '48', '72'];

const HEADINGS = [
  { v: 'p',  label: 'Normal' },
  { v: '1',  label: 'Heading 1' },
  { v: '2',  label: 'Heading 2' },
  { v: '3',  label: 'Heading 3' },
  { v: '4',  label: 'Heading 4' },
];

// Toolbar icon button. mousedown+preventDefault keeps the editor selection
// alive (a plain click would blur the contenteditable before the command runs).
function Tb({ onClick, active, title, icon, children }) {
  return (
    <button type="button" title={title} aria-label={title} aria-pressed={!!active}
      onMouseDown={(e) => { e.preventDefault(); onClick(); }}
      className={`rte-btn${active ? ' is-active' : ''}`}>
      {icon ? <i className={`bi bi-${icon}`} /> : children}
    </button>
  );
}

function Group({ children }) {
  return <div className="rte-group">{children}</div>;
}
function Sep() {
  return <span className="rte-sep" aria-hidden="true" />;
}

// Styled dropdown with a custom chevron (native arrow stripped) so it matches
// the icon buttons in both light and dark themes.
function ToolSelect({ value, onChange, title, minWidth, children }) {
  return (
    <span className="rte-select-wrap" style={minWidth ? { minWidth } : undefined}>
      <select className="rte-select" value={value} onChange={onChange} title={title} aria-label={title}>
        {children}
      </select>
      <i className="bi bi-chevron-down rte-select-caret" aria-hidden="true" />
    </span>
  );
}

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
    <div className={`rte-container${readOnly ? ' is-readonly' : ''}`}>
      {!readOnly && (
        <div className="rte-toolbar">
          <Group>
            <Tb title="Bold (Ctrl+B)" icon="type-bold" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()} />
            <Tb title="Italic (Ctrl+I)" icon="type-italic" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()} />
            <Tb title="Underline (Ctrl+U)" icon="type-underline" active={editor.isActive('underline')} onClick={() => editor.chain().focus().toggleUnderline().run()} />
            <Tb title="Strikethrough" icon="type-strikethrough" active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()} />
          </Group>
          <Sep />
          <Group>
            <ToolSelect value={headingValue} onChange={(e) => setHeading(e.target.value)} title="Paragraph style" minWidth={108}>
              {HEADINGS.map((h) => <option key={h.v} value={h.v}>{h.label}</option>)}
            </ToolSelect>
            <ToolSelect value="" onChange={(e) => { if (e.target.value) editor.chain().focus().setFontSize(`${e.target.value}px`).run(); }} title="Font size (px)" minWidth={72}>
              <option value="">Size</option>
              {FONT_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
            </ToolSelect>
          </Group>
          <Sep />
          <Group>
            <Tb title="Bulleted list" icon="list-ul" active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()} />
            <Tb title="Numbered list" icon="list-ol" active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()} />
            <Tb title="Checklist" icon="list-check" active={editor.isActive('taskList')} onClick={() => editor.chain().focus().toggleTaskList().run()} />
          </Group>
          <Sep />
          <Group>
            <Tb title="Align left" icon="text-left" active={editor.isActive({ textAlign: 'left' })} onClick={() => editor.chain().focus().setTextAlign('left').run()} />
            <Tb title="Align center" icon="text-center" active={editor.isActive({ textAlign: 'center' })} onClick={() => editor.chain().focus().setTextAlign('center').run()} />
            <Tb title="Align right" icon="text-right" active={editor.isActive({ textAlign: 'right' })} onClick={() => editor.chain().focus().setTextAlign('right').run()} />
            <Tb title="Justify" icon="justify" active={editor.isActive({ textAlign: 'justify' })} onClick={() => editor.chain().focus().setTextAlign('justify').run()} />
          </Group>
          <Sep />
          <Group>
            <Tb title="Decrease indent (Shift+Tab)" icon="text-indent-left" onClick={() => editor.chain().focus().outdent().run()} />
            <Tb title="Increase indent (Tab)" icon="text-indent-right" onClick={() => editor.chain().focus().indent().run()} />
          </Group>
          <Sep />
          <Group>
            <Tb title="Quote" icon="quote" active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()} />
            <Tb title="Code block" icon="code-slash" active={editor.isActive('codeBlock')} onClick={() => editor.chain().focus().toggleCodeBlock().run()} />
            <Tb title="Divider" icon="hr" onClick={() => editor.chain().focus().setHorizontalRule().run()} />
            <Tb title="Insert / edit link" icon="link-45deg" active={editor.isActive('link')} onClick={handleLink} />
          </Group>
          <Sep />
          <Group>
            <Tb title="Highlight selection" icon="highlighter" active={editor.isActive('rhHighlight')}
              onClick={() => editor.chain().focus().toggleRhHighlight({ color: hColor, intensity: hIntensity }).run()} />
            <HighlighterPicker color={hColor} onColorChange={setHColor} intensity={hIntensity} onIntensityChange={setHIntensity} compact />
          </Group>
          <Sep />
          <Group>
            <Tb title="Clear formatting" icon="eraser" onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()} />
          </Group>
          <Sep />
          <Group>
            <Tb title="Undo (Ctrl+Z)" icon="arrow-counterclockwise" onClick={() => editor.chain().focus().undo().run()} />
            <Tb title="Redo (Ctrl+Y)" icon="arrow-clockwise" onClick={() => editor.chain().focus().redo().run()} />
          </Group>
        </div>
      )}

      <EditorContent editor={editor} />

      <style>{`
        .rte-container {
          border: 1px solid var(--border-default);
          border-radius: var(--radius-md);
          background: var(--surface-1);
          transition: border-color 130ms ease, box-shadow 130ms ease;
        }
        .rte-container:focus-within {
          border-color: var(--accent);
          box-shadow: 0 0 0 3px var(--accent-soft);
        }

        .rte-toolbar {
          position: sticky; top: 0; z-index: 5;
          display: flex; flex-wrap: wrap; align-items: center; gap: 3px;
          padding: 8px 10px;
          background: color-mix(in srgb, var(--surface-2) 88%, transparent);
          backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
          border-bottom: 1px solid var(--border-subtle);
          border-radius: calc(var(--radius-md) - 1px) calc(var(--radius-md) - 1px) 0 0;
        }
        .rte-group { display: inline-flex; align-items: center; gap: 2px; }
        .rte-sep { width: 1px; height: 22px; background: var(--border-subtle); margin: 0 5px; flex: 0 0 auto; }

        .rte-btn {
          background: transparent; border: 1px solid transparent; border-radius: 7px;
          height: 32px; min-width: 32px; padding: 0 7px;
          display: inline-flex; align-items: center; justify-content: center;
          cursor: pointer; color: var(--text-secondary);
          font-size: 15px; line-height: 1; font-family: inherit;
          transition: background 110ms ease, color 110ms ease, border-color 110ms ease, transform 60ms ease;
        }
        .rte-btn i { font-size: 15px; line-height: 1; }
        .rte-btn:hover { background: color-mix(in srgb, var(--text-primary) 9%, transparent); color: var(--text-primary); }
        .rte-btn:active { transform: translateY(0.5px); }
        .rte-btn.is-active {
          background: var(--accent-soft);
          border-color: color-mix(in srgb, var(--accent) 38%, transparent);
          color: var(--accent);
        }

        .rte-select-wrap { position: relative; display: inline-flex; align-items: center; }
        .rte-select {
          appearance: none; -webkit-appearance: none; -moz-appearance: none;
          background: var(--surface-1); border: 1px solid var(--border-default); border-radius: 7px;
          height: 32px; padding: 0 26px 0 10px; width: 100%;
          font-size: 12.5px; font-weight: 600; color: var(--text-primary);
          cursor: pointer; font-family: inherit;
          transition: border-color 110ms ease, background 110ms ease;
        }
        .rte-select:hover { border-color: var(--border-strong); background: var(--surface-2); }
        .rte-select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
        .rte-select-caret { position: absolute; right: 9px; font-size: 9px; color: var(--text-muted); pointer-events: none; }

        .rte-surface { padding: 14px 16px; font-size: 13.5px; line-height: 1.65; outline: none; color: var(--text-primary); word-break: break-word; }
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
