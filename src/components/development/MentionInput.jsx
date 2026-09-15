// A comment box that suggests people after "@".
//
// The text keeps "@Display Name"; the chosen people's ids are reported through
// onMention so the database can notify exactly those people.
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Avatar } from './ui';

export default function MentionInput({
  value, onChange, people, onMention, onSubmit, placeholder, autoFocus = false, label = 'Comment', rows = 3, id,
}) {
  const ref = useRef(null);
  const [query, setQuery] = useState(null); // { text, start }
  const [active, setActive] = useState(0);
  // Where the caret goes once the inserted name is on screen. Set in a layout
  // effect (before the browser handles the next key), never a later frame,
  // or fast typing lands in front of the name.
  const pendingCaret = useRef(null);
  useLayoutEffect(() => {
    if (pendingCaret.current == null || !ref.current) return;
    ref.current.focus();
    ref.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  });

  const matches = useMemo(() => {
    if (!query) return [];
    const q = query.text.toLowerCase();
    return (people || []).filter((p) => (p.display_name || '').toLowerCase().includes(q)).slice(0, 6);
  }, [people, query]);

  function detect(text, caret) {
    const before = text.slice(0, caret);
    const match = /(^|\s)@([^\s@]{0,24})$/.exec(before);
    setQuery(match ? { text: match[2], start: caret - match[2].length - 1 } : null);
    setActive(0);
  }

  function pick(person) {
    const el = ref.current;
    if (!el || !query) return;
    const caret = el.selectionStart;
    const insert = `@${person.display_name} `;
    const next = `${value.slice(0, query.start)}${insert}${value.slice(caret)}`;
    pendingCaret.current = query.start + insert.length;
    onChange(next);
    onMention?.(person);
    setQuery(null);
  }

  return (
    <div className="dv-mention-wrap">
      <textarea
        ref={ref}
        id={id}
        aria-label={label}
        value={value}
        rows={rows}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(event) => {
          onChange(event.target.value);
          detect(event.target.value, event.target.selectionStart);
        }}
        onClick={(event) => detect(event.currentTarget.value, event.currentTarget.selectionStart)}
        onBlur={() => setTimeout(() => setQuery(null), 120)}
        onKeyDown={(event) => {
          if (query && matches.length) {
            if (event.key === 'ArrowDown') { event.preventDefault(); setActive((i) => (i + 1) % matches.length); return; }
            if (event.key === 'ArrowUp') { event.preventDefault(); setActive((i) => (i - 1 + matches.length) % matches.length); return; }
            if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); pick(matches[active]); return; }
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setQuery(null); return; }
          }
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            onSubmit?.();
          }
        }}
      />
      {query && matches.length > 0 && (
        <ul className="dv-mention-list" role="listbox" aria-label="Mention someone">
          {matches.map((person, i) => (
            <li key={person.id} role="option" aria-selected={i === active}>
              <button
                type="button"
                className={i === active ? 'is-active' : ''}
                onMouseDown={(event) => { event.preventDefault(); pick(person); }}
              >
                <Avatar person={person} size={20} />
                <span>{person.display_name}</span>
                <small>{person.role === 'boss' ? 'Boss' : 'Developer'}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Keeps only the ids whose "@Name" is still in the text when it is sent.
export function keptMentions(body, ids, personById) {
  return [...new Set(ids)].filter((id) => {
    const name = personById.get(id)?.display_name;
    return name && body.includes(`@${name}`);
  });
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Renders a comment body with the @mentions highlighted.
export function withMentions(body, ids, personById) {
  const names = (ids || [])
    .map((id) => personById.get(id)?.display_name)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (!names.length) return body;
  const pattern = new RegExp(`@(${names.map(escapeRegExp).join('|')})`, 'g');
  const out = [];
  let last = 0;
  let match;
  while ((match = pattern.exec(body))) {
    if (match.index > last) out.push(body.slice(last, match.index));
    out.push(<span key={match.index} className="dv-mention">@{match[1]}</span>);
    last = match.index + match[0].length;
  }
  if (last < body.length) out.push(body.slice(last));
  return out;
}
