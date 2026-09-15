// Small building blocks shared by every Development page.
import { useEffect, useRef, useState } from 'react';
import { PRIORITY_BY_KEY, STATUS_BY_KEY, TYPE_BY_KEY, initials } from './devModel';

function toneFor(id = '') {
  let hash = 0;
  for (const ch of String(id)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash % 6;
}

export function Avatar({ person, size = 24, className = '' }) {
  const name = person?.display_name || 'Unassigned';
  const style = { width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.38)) };
  if (person?.avatar_url) {
    return <img className={`dv-avatar ${className}`} style={style} src={person.avatar_url} alt="" title={name} />;
  }
  return (
    <span
      className={`dv-avatar ${person ? `tone-${toneFor(person.id)}` : 'is-empty'} ${className}`}
      style={style}
      title={name}
      aria-hidden="true"
    >
      {person ? initials(name) : <i className="bi bi-person" />}
    </span>
  );
}

export function AvatarStack({ people, max = 4, size = 24 }) {
  const list = (people || []).filter(Boolean);
  if (!list.length) return null;
  return (
    <span className="dv-avatar-stack" title={list.map((p) => p.display_name).join(', ')}>
      {list.slice(0, max).map((person) => <Avatar key={person.id} person={person} size={size} />)}
      {list.length > max && (
        <span className="dv-avatar dv-avatar-more" style={{ width: size, height: size }}>+{list.length - max}</span>
      )}
    </span>
  );
}

export function StatusPill({ status }) {
  const s = STATUS_BY_KEY[status] || STATUS_BY_KEY.todo;
  return <span className={`dv-status is-${s.tone}`}><i aria-hidden="true" />{s.label}</span>;
}

export function PriorityFlag({ priority }) {
  const p = PRIORITY_BY_KEY[priority] || PRIORITY_BY_KEY.normal;
  return <span className={`dv-priority is-${p.key}`}><i className="bi bi-flag-fill" aria-hidden="true" />{p.label}</span>;
}

export function TypeIcon({ type }) {
  const t = TYPE_BY_KEY[type] || TYPE_BY_KEY.feature;
  return <i className={`bi ${t.icon} dv-type is-${t.key}`} title={t.label} aria-label={t.label} role="img" />;
}

export function ProjectMark({ project, size = 36 }) {
  if (!project) return null;
  return (
    <span
      className={`dv-mark c-${project.color}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.46) }}
      aria-hidden="true"
    >
      {project.symbol}
    </span>
  );
}

export function StateBadge({ state }) {
  if (!state) return null;
  return <span className={`dv-badge is-${state.tone}`}>{state.label}</span>;
}

export function ProgressBar({ pct, color, label }) {
  const value = Math.max(0, Math.min(100, Math.round(pct || 0)));
  return (
    <span className="dv-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} aria-label={label}>
      <span className={color ? `c-${color}` : ''} style={{ width: `${value}%` }} />
    </span>
  );
}

export function EmptyState({ icon = 'bi-inboxes', title, children, action, compact = false }) {
  return (
    <div className={`dv-empty${compact ? ' is-compact' : ''}`}>
      <i className={`bi ${icon}`} aria-hidden="true" />
      {title && <strong>{title}</strong>}
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Spinner({ label = 'Loading' }) {
  return <span className="dv-spinner" role="status" aria-label={label} />;
}

export function DevHeader({ eyebrow, title, subtitle, actions, leading }) {
  return (
    <header className="dv-head">
      <div className="dv-head-text">
        {eyebrow && <div className="dv-eyebrow">{eyebrow}</div>}
        <div className="dv-head-title">
          {leading}
          <h1>{title}</h1>
        </div>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="dv-head-actions">{actions}</div>}
    </header>
  );
}

export function Segmented({ value, options, onChange, label }) {
  return (
    <div className="dv-seg" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={option.value === value ? 'is-on' : ''}
          aria-pressed={option.value === value}
          title={option.title}
          onClick={() => onChange(option.value)}
        >
          {option.icon && <i className={`bi ${option.icon}`} aria-hidden="true" />}
          {option.label && <span>{option.label}</span>}
        </button>
      ))}
    </div>
  );
}

// A "…" button with a small list of actions. Escape closes the list without
// closing the panel or dialog it sits in.
export function ActionMenu({ label = 'More actions', items, icon = 'bi-three-dots', align = 'end' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (event) => { if (ref.current && !ref.current.contains(event.target)) setOpen(false); };
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const visible = (items || []).filter(Boolean);
  if (!visible.length) return null;
  return (
    <span className="dv-menu" ref={ref}>
      <button
        type="button"
        className="dv-icon-btn"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <i className={`bi ${icon}`} aria-hidden="true" />
      </button>
      {open && (
        <span className={`dv-menu-list is-${align}`} role="menu">
          {visible.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={item.danger ? 'is-danger' : ''}
              onClick={() => { setOpen(false); item.onClick(); }}
            >
              {item.icon && <i className={`bi ${item.icon}`} aria-hidden="true" />}
              {item.label}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

export function PersonName({ person, fallback = 'Unassigned' }) {
  return <span>{person?.display_name || fallback}</span>;
}
