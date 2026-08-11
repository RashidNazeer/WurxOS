import React, { useEffect, useMemo, useRef, useState } from 'react';

/**
 * Standalone multi-select "Clients" filter for the report lists — pulled out
 * of the Filters popover so the OL can view several clients' reports at once.
 *
 * Props:
 *   options:  string[]            — client names to choose from
 *   selected: string[]            — currently-selected client names
 *   onChange: (next: string[]) => void
 *
 * Renders nothing when there are no clients to filter by.
 */
export default function ClientMultiSelect({ options = [], selected = [], onChange }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const anchorRef = useRef(null);
  const popRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (popRef.current && !popRef.current.contains(e.target) && !anchorRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.toLowerCase().includes(q)) : options;
  }, [options, query]);

  if (!options.length) return null;

  const count = selected.length;
  const label = count === 0 ? 'All Clients' : count === 1 ? selected[0] : `${count} clients`;

  const toggle = (name) => {
    onChange(selected.includes(name) ? selected.filter((x) => x !== name) : [...selected, name]);
  };

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button ref={anchorRef} type="button"
        className="btn btn-sm d-inline-flex align-items-center gap-1"
        style={{
          borderRadius: 8, fontSize: '0.78rem', fontWeight: 500, maxWidth: 220,
          border: `1px solid ${count ? 'var(--info)' : 'var(--border-default)'}`,
          background: count ? 'var(--info-soft)' : 'var(--surface-1)',
          color: count ? 'var(--info)' : 'var(--text-secondary)',
        }}
        onClick={() => setOpen((v) => !v)}
        title="Filter by one or more clients">
        <i className="bi bi-people" />
        <span className="text-truncate">{label}</span>
        {count > 0 && (
          <span className="badge rounded-pill" style={{ background: '#3b82f6', color: 'white', fontSize: '0.6rem' }}>{count}</span>
        )}
        <i className="bi bi-chevron-down" style={{ fontSize: '0.62rem', opacity: 0.7 }} />
      </button>

      {open && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 999, background: 'rgba(15, 23, 42, 0.25)', backdropFilter: 'blur(2px)' }}
            onClick={() => setOpen(false)} />
          <div ref={popRef}
            style={{
              position: 'absolute', top: 'calc(100% + 8px)', left: 0, zIndex: 1000, width: 280,
              background: 'var(--surface-1)', border: '1px solid var(--border-default)', borderRadius: 14,
              boxShadow: '0 20px 40px -10px rgba(15, 23, 42, 0.35), 0 8px 16px -6px rgba(15, 23, 42, 0.15)',
              overflow: 'hidden',
            }}>
            <div className="d-flex align-items-center justify-content-between"
              style={{ padding: '12px 14px', background: 'linear-gradient(135deg, var(--info-soft) 0%, var(--purple-soft) 100%)', borderBottom: '1px solid var(--border-subtle)' }}>
              <div className="fw-bold" style={{ fontSize: '0.84rem', color: 'var(--text-primary)' }}>
                <i className="bi bi-people me-2" style={{ color: 'var(--info)' }} />Clients
              </div>
              {count > 0 && (
                <button type="button" className="btn btn-sm p-0 d-inline-flex align-items-center gap-1"
                  style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', background: 'none', border: 'none' }}
                  onClick={() => onChange([])}>
                  <i className="bi bi-x-circle" /> Clear
                </button>
              )}
            </div>

            <div style={{ padding: 12 }}>
              {options.length > 8 && (
                <input type="text" className="form-control form-control-sm mb-2" placeholder="Search clients…"
                  style={{ borderRadius: 8, fontSize: '0.8rem' }}
                  value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
              )}
              <div className="d-flex align-items-center justify-content-between mb-2" style={{ fontSize: '0.7rem' }}>
                <span className="text-muted">{count} selected</span>
                <button type="button" className="btn btn-sm p-0"
                  style={{ fontSize: '0.7rem', color: 'var(--info)', background: 'none', border: 'none', fontWeight: 600 }}
                  onClick={() => onChange(count === options.length ? [] : [...options])}>
                  {count === options.length ? 'Clear all' : 'Select all'}
                </button>
              </div>

              <div className="d-flex flex-column gap-1" style={{ maxHeight: '46vh', overflowY: 'auto' }}>
                {shown.length === 0 ? (
                  <div className="text-muted small py-2 text-center">No clients match.</div>
                ) : shown.map((name) => {
                  const on = selected.includes(name);
                  return (
                    <label key={name} className="d-flex align-items-center gap-2 rounded-2 px-2 py-1"
                      style={{ cursor: 'pointer',
                        background: on ? 'var(--info-soft)' : 'transparent',
                        border: `1px solid ${on ? 'color-mix(in srgb, var(--info) 40%, transparent)' : 'transparent'}` }}>
                      <input type="checkbox" className="form-check-input mt-0" checked={on} onChange={() => toggle(name)} />
                      <span className="text-truncate" style={{ fontSize: '0.82rem', fontWeight: on ? 700 : 500, color: on ? 'var(--info)' : 'var(--text-primary)' }}>
                        {name}
                      </span>
                    </label>
                  );
                })}
              </div>

              <div className="d-flex justify-content-end mt-3 pt-2" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                <button type="button" className="btn btn-sm btn-dark px-3" style={{ borderRadius: 8, fontSize: '0.76rem' }}
                  onClick={() => setOpen(false)}>Done</button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
