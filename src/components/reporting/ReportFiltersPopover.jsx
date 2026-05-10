import React, { useEffect, useRef, useState } from 'react';

/**
 * Compact filters popover triggered by a filter icon button.
 *
 * Props:
 *   filters: [{ key, label, value, setValue, options: [{value, label}] }]
 *   onClear: () => void
 */
export default function ReportFiltersPopover({ filters, onClear }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef(null);
  const popRef = useRef(null);

  const activeCount = filters.filter(f => f.value).length;

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (popRef.current && !popRef.current.contains(e.target) && !anchorRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button ref={anchorRef} type="button"
        className="btn btn-sm d-inline-flex align-items-center gap-1"
        style={{
          borderRadius: 8,
          fontSize: '0.78rem',
          border: `1px solid ${activeCount ? '#3b82f6' : '#d1d5db'}`,
          background: activeCount ? '#eff6ff' : '#fff',
          color: activeCount ? '#1d4ed8' : '#334155',
          fontWeight: 500,
        }}
        onClick={() => setOpen(v => !v)}>
        <i className="bi bi-sliders" />
        <span>Filters</span>
        {activeCount > 0 && (
          <span className="badge rounded-pill" style={{ background: '#3b82f6', color: 'white', fontSize: '0.6rem' }}>
            {activeCount}
          </span>
        )}
      </button>

      {open && (
        <>
          {/* Backdrop that dims the page behind the popover */}
          <div style={{
            position: 'fixed', inset: 0, zIndex: 999,
            background: 'rgba(15, 23, 42, 0.25)', backdropFilter: 'blur(2px)',
          }} onClick={() => setOpen(false)} />

          <div ref={popRef}
            style={{
              position: 'absolute',
              top: 'calc(100% + 8px)',
              right: 0,
              zIndex: 1000,
              width: 320,
              background: 'var(--surface-1)',
              border: '1px solid var(--border-default)',
              borderRadius: 14,
              padding: 0,
              boxShadow: '0 20px 40px -10px rgba(15, 23, 42, 0.35), 0 8px 16px -6px rgba(15, 23, 42, 0.15)',
              overflow: 'hidden',
            }}>
            <div className="d-flex align-items-center justify-content-between"
              style={{
                padding: '12px 14px',
                background: 'linear-gradient(135deg, #eff6ff 0%, #f5f3ff 100%)',
                borderBottom: '1px solid var(--border-subtle)',
              }}>
              <div className="fw-bold" style={{ fontSize: '0.84rem', color: 'var(--text-primary)' }}>
                <i className="bi bi-sliders me-2" style={{ color: 'var(--info)' }} />Filters
              </div>
              {activeCount > 0 && (
                <button type="button" className="btn btn-sm p-0 d-inline-flex align-items-center gap-1"
                  style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', background: 'none', border: 'none' }}
                  onClick={() => { onClear(); }}>
                  <i className="bi bi-x-circle" /> Clear all
                </button>
              )}
            </div>
            <div style={{ padding: 14, maxHeight: '60vh', overflowY: 'auto' }}>
              <div className="d-flex flex-column gap-2">
                {filters.map(f => (
                  <div key={f.key}>
                    <label className="text-muted d-block mb-1" style={{ fontSize: '0.68rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                      {f.label}
                    </label>
                    <select className="form-select form-select-sm"
                      style={{ borderRadius: 8, fontSize: '0.82rem' }}
                      value={f.value} onChange={e => f.setValue(e.target.value)}>
                      <option value="">All {f.label}s</option>
                      {f.options.map(o => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
              <div className="d-flex justify-content-end mt-3 pt-2" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                <button type="button" className="btn btn-sm btn-dark px-3"
                  style={{ borderRadius: 8, fontSize: '0.76rem' }}
                  onClick={() => setOpen(false)}>
                  Done
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
