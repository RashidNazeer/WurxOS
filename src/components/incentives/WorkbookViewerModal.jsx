// Read-only view of the whole brand workbook, for the Boss and OLs (the Incentives page button).
//
// Downloads the published sheet the same way the target picker does, parses every tab in the
// browser and shows it as a table. Nothing is stored or uploaded, nothing is editable here, and the
// Google link itself is never shown -- people read the data through the app. The link can only be
// read by the Boss / OLs anyway (app_config RLS, mig 423); the page also only offers the button to them.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { getIncentiveWorkbookUrl } from '../../lib/incentivesApi';
import { fetchWorkbookBuffer } from '../../lib/incentiveWorkbookLoad';

const MAX_ROWS = 500;

export default function WorkbookViewerModal({ onClose }) {
  const [state, setState] = useState({ status: 'loading', error: '' });
  const [book, setBook] = useState(null);       // { XLSX, wb }
  const [active, setActive] = useState(null);
  const [filter, setFilter] = useState('');
  const [fetchedAt, setFetchedAt] = useState(null);

  const load = useCallback(async () => {
    setState({ status: 'loading', error: '' });
    try {
      const url = await getIncentiveWorkbookUrl();
      if (!url) { setState({ status: 'nolink', error: '' }); return; }
      const buf = await fetchWorkbookBuffer(typeof url === 'string' ? url : url.url);
      const XLSX = await import('xlsx');
      const wb = XLSX.read(buf, { type: 'array' });
      if (!wb.SheetNames?.length) throw new Error('The workbook has no sheets.');
      setBook({ XLSX, wb });
      setActive((cur) => (cur && wb.SheetNames.includes(cur) ? cur : wb.SheetNames[0]));
      setFetchedAt(new Date());
      setState({ status: 'ready', error: '' });
    } catch (e) {
      setState({ status: 'error', error: e?.message || String(e) });
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const names = useMemo(() => {
    const all = book?.wb.SheetNames || [];
    const f = filter.trim().toLowerCase();
    return f ? all.filter((n) => n.toLowerCase().includes(f)) : all;
  }, [book, filter]);

  // Cells exactly as the sheet shows them (formatted text, so 0.95 reads "95%").
  const grid = useMemo(() => {
    if (!book || !active || !book.wb.Sheets[active]) return [];
    return book.XLSX.utils.sheet_to_json(book.wb.Sheets[active], { header: 1, raw: false, defval: '', blankrows: false });
  }, [book, active]);
  const cols = useMemo(() => grid.reduce((m, r) => Math.max(m, r.length), 0), [grid]);
  const shown = grid.slice(0, MAX_ROWS);

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 1080, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'var(--backdrop)', backdropFilter: 'blur(2.6px)' }} onClick={onClose} />
      <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 1280, height: '88vh', zIndex: 1, borderRadius: 'var(--radius-lg)', display: 'flex', flexDirection: 'column' }}>
        <div className="d-flex align-items-center justify-content-between px-4 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <div>
            <div className="fw-bold" style={{ fontSize: '0.95rem' }}><i className="bi bi-file-earmark-spreadsheet me-2" />Brand workbook</div>
            <div className="text-muted" style={{ fontSize: '0.72rem' }}>
              Read-only · the live sheet{fetchedAt ? ` · loaded ${fetchedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
              {book ? ` · ${book.wb.SheetNames.length} tabs` : ''}
            </div>
          </div>
          <div className="d-flex align-items-center gap-2">
            <button className="btn btn-sm btn-outline-secondary" onClick={load} disabled={state.status === 'loading'} title="Load the latest version of the sheet">
              <i className={`bi ${state.status === 'loading' ? 'bi-hourglass-split' : 'bi-arrow-clockwise'} me-1`} />Refresh
            </button>
            <button className="btn btn-sm p-0 px-1" style={{ fontSize: '0.9rem', lineHeight: 1 }} onClick={onClose} aria-label="Close">✕</button>
          </div>
        </div>

        {state.status === 'loading' && !book && (
          <div className="p-4 text-muted"><span className="spinner-border spinner-border-sm me-2" />Loading the workbook…</div>
        )}
        {state.status === 'nolink' && (
          <div className="p-4 text-muted">No workbook link is saved yet. Add it from "Add from brand workbook" on an APC's plan, then come back here.</div>
        )}
        {state.status === 'error' && (
          <div className="p-4"><div className="alert alert-danger mb-0" style={{ fontSize: '0.82rem' }}>{state.error}</div></div>
        )}

        {book && (
          <div className="d-flex flex-grow-1" style={{ minHeight: 0 }}>
            <div className="d-flex flex-column" style={{ width: 230, borderRight: '1px solid var(--border-subtle)', minHeight: 0 }}>
              <div className="p-2">
                <input className="form-control form-control-sm" placeholder="Find a brand tab…" value={filter} onChange={(e) => setFilter(e.target.value)} />
              </div>
              <div style={{ overflowY: 'auto', flexGrow: 1 }}>
                {names.length === 0 && <div className="text-muted small px-3 py-2">No tab matches.</div>}
                {names.map((n) => (
                  <button key={n} type="button" onClick={() => setActive(n)}
                    className="btn w-100 text-start px-3 py-2"
                    style={{ border: 'none', borderRadius: 0, fontSize: '0.8rem', fontWeight: n === active ? 700 : 500,
                      background: n === active ? 'var(--accent-soft)' : 'transparent', color: n === active ? 'var(--accent)' : 'var(--text-primary)' }}>
                    {n}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ flexGrow: 1, minWidth: 0, overflow: 'auto' }}>
              {grid.length === 0 ? (
                <div className="text-muted p-4 small">This tab is empty.</div>
              ) : (
                <table style={{ borderCollapse: 'separate', borderSpacing: 0, fontSize: '0.78rem', width: 'max-content', minWidth: '100%' }}>
                  <tbody>
                    {shown.map((row, r) => (
                      <tr key={r}>
                        {Array.from({ length: cols }, (_, c) => {
                          const v = row[c] ?? '';
                          const first = c === 0;
                          return (
                            <td key={c} style={{
                              padding: '5px 10px', whiteSpace: 'nowrap', borderBottom: '1px solid var(--border-subtle)', borderRight: '1px solid var(--border-subtle)',
                              color: 'var(--text-primary)', fontWeight: first ? 600 : 400,
                              ...(first ? { position: 'sticky', left: 0, background: 'var(--surface-1)', zIndex: 1 } : {}),
                            }}>{String(v)}</td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {grid.length > MAX_ROWS && (
                <div className="text-muted small p-3">Showing the first {MAX_ROWS} of {grid.length} rows.</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
