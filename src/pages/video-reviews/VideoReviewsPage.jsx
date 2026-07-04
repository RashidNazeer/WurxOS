import { useEffect, useMemo, useState } from 'react';
import { runVideoReviewTargets, downloadHandlesCsv, listMyEukaBrands } from '../../lib/videoReviewApi';

// ── Pakistan-time date helpers ──────────────────────────────────────
// Default target date = 2 days before TODAY in Pakistan (Asia/Karachi).
// We format "now" in Karachi, then subtract days on that calendar date.
function pakistanToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date()); // en-CA → YYYY-MM-DD
  return parts;
}
function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const prettyDate = (ymd) => {
  if (!ymd) return '';
  const d = new Date(ymd + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
};

const FILE_DEFS = [
  { key: 'group1', ord: '1st', title: 'send their 1st video review message' },
  { key: 'group2', ord: '2nd', title: 'send their 2nd video review message' },
  { key: 'group3', ord: '3rd', title: 'send their 3rd video review message' },
];

export default function VideoReviewsPage() {
  const defaultTarget = useMemo(() => addDays(pakistanToday(), -2), []);
  const [targetDate, setTargetDate] = useState(defaultTarget);
  const [missed, setMissed] = useState([]);          // up to 2 YYYY-MM-DD
  const [status, setStatus] = useState('idle');       // idle | running | done | error
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  // Which Euka brands this user can run for (Boss/OL: all; APC: their own).
  const [brands, setBrands] = useState(null);         // null = loading
  const [brandId, setBrandId] = useState('');
  useEffect(() => {
    let cancelled = false;
    listMyEukaBrands()
      .then((list) => {
        if (cancelled) return;
        setBrands(list);
        if (list.length === 1) setBrandId(list[0].id); // preselect the only one
      })
      .catch(() => { if (!cancelled) setBrands([]); });
    return () => { cancelled = true; };
  }, []);

  const selectedBrand = (brands || []).find((b) => b.id === brandId) || null;
  const brandLabel = selectedBrand?.brand_name || 'Brand';
  const maxDate = pakistanToday();                    // can't target the future

  function addMissed() {
    if (missed.length >= 2) return;
    setMissed((m) => [...m, '']);
  }
  function setMissedAt(i, v) { setMissed((m) => m.map((x, idx) => (idx === i ? v : x))); }
  function removeMissed(i) { setMissed((m) => m.filter((_, idx) => idx !== i)); }

  async function generate() {
    setError('');
    if (!brandId) { setError('Pick a brand first.'); return; }
    const cleanMissed = [...new Set(missed.map((d) => d.trim()).filter(Boolean))]
      .filter((d) => d <= targetDate);
    setStatus('running');
    setResult(null);
    try {
      const data = await runVideoReviewTargets({ brandId, targetDate, missedDates: cleanMissed });
      setResult(data);
      // Auto-download the three files immediately, named by the brand.
      const label = data.brandLabel || brandLabel;
      for (const def of FILE_DEFS) {
        downloadHandlesCsv(data[def.key] || [], `${label} - ${def.ord} video review creators.csv`);
      }
      setStatus('done');
    } catch (e) {
      setError(e?.message || 'Something went wrong.');
      setStatus('error');
    }
  }

  function redownload(def) {
    if (!result) return;
    const label = result.brandLabel || brandLabel;
    downloadHandlesCsv(result[def.key] || [], `${label} - ${def.ord} video review creators.csv`);
  }

  function reset() {
    setStatus('idle'); setResult(null); setError('');
  }

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: '8px 4px 40px' }}>
      {/* Header */}
      <div style={{ marginBottom: 22 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div className="rounded-3 d-flex align-items-center justify-content-center"
            style={{ width: 40, height: 40, background: 'var(--accent-soft)' }}>
            <i className="bi bi-camera-video" style={{ fontSize: '1.1rem', color: 'var(--accent)' }} />
          </div>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: 'var(--text-primary)' }}>Video Reviews</h1>
            <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              Generate a brand's 1st / 2nd / 3rd video-review creator lists for a chosen date.
            </div>
          </div>
        </div>
      </div>

      {/* No Euka brand → nothing to run */}
      {brands !== null && brands.length === 0 && (
        <div className="wx-card" style={{ padding: 28, textAlign: 'center' }}>
          <i className="bi bi-camera-video" style={{ fontSize: 30, color: 'var(--text-muted)', opacity: 0.5 }} />
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', marginTop: 10 }}>
            No Euka brand to run
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 4 }}>
            None of your brands are linked to a Euka store yet. Ask your Team Lead or the Boss to
            link the brand to Euka, then this page will let you generate its video-review files.
          </div>
        </div>
      )}

      {/* Setup card */}
      {brands !== null && brands.length > 0 && (
      <div className="wx-card" style={{ padding: 22 }}>
        {/* Brand picker — dropdown when the user has more than one Euka brand */}
        {brands.length > 1 ? (
          <div style={{ marginBottom: 18 }}>
            <label className="wx-label">Brand</label>
            <select className="wx-input" value={brandId}
              onChange={(e) => { setBrandId(e.target.value); reset(); }}
              disabled={status === 'running'}>
              <option value="">— Select a brand —</option>
              {brands.map((b) => (<option key={b.id} value={b.id}>{b.brand_name}</option>))}
            </select>
          </div>
        ) : (
          <div style={{ marginBottom: 18, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="wx-label" style={{ margin: 0 }}>Brand:</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>{brandLabel}</span>
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
          {/* Target date */}
          <div>
            <label className="wx-label">Target date</label>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 6 }}>
              The day you're sending messages for. Defaults to 2 days ago (Pakistan time).
            </div>
            <input type="date" className="wx-input"
              value={targetDate} max={maxDate}
              onChange={(e) => setTargetDate(e.target.value)}
              disabled={status === 'running'} />
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6 }}>
              {prettyDate(targetDate)}
            </div>
          </div>

          {/* Missed run dates */}
          <div>
            <label className="wx-label">Missed run dates <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional, max 2)</span></label>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 6 }}>
              Days you skipped running this recently. Leave empty for none.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {missed.map((d, i) => (
                <div key={i} style={{ display: 'flex', gap: 6 }}>
                  <input type="date" className="wx-input" value={d} max={targetDate}
                    onChange={(e) => setMissedAt(i, e.target.value)}
                    disabled={status === 'running'} />
                  <button className="wx-btn wx-btn-ghost" onClick={() => removeMissed(i)}
                    disabled={status === 'running'} title="Remove"
                    style={{ padding: '0 10px', color: 'var(--danger)' }}>
                    <i className="bi bi-x-lg" />
                  </button>
                </div>
              ))}
              {missed.length < 2 && (
                <button className="wx-btn wx-btn-ghost align-self-start" onClick={addMissed}
                  disabled={status === 'running'}
                  style={{ borderStyle: 'dashed', fontSize: 12.5 }}>
                  <i className="bi bi-plus-circle me-1" /> Add a missed date
                </button>
              )}
            </div>
          </div>
        </div>

        <div style={{ borderTop: '1px solid var(--border-subtle)', margin: '20px 0 16px' }} />

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            <i className="bi bi-info-circle me-1" />
            Three CSV files download automatically when ready — one per message group.
          </div>
          <button className="wx-btn wx-btn-primary" onClick={generate}
            disabled={status === 'running' || !targetDate || !brandId}
            style={{ padding: '10px 22px', fontSize: 14, fontWeight: 700 }}>
            <i className="bi bi-download me-2" />
            Generate video review files
          </button>
        </div>

        {status === 'error' && (
          <div className="wx-alert wx-alert-danger" style={{ marginTop: 14 }}>
            <i className="bi bi-exclamation-triangle me-2" />
            {error} <button className="wx-btn wx-btn-ghost ms-2" onClick={reset} style={{ padding: '2px 10px', fontSize: 12 }}>Try again</button>
          </div>
        )}
      </div>
      )}

      {/* Success summary */}
      {status === 'done' && result && (
        <div className="wx-card" style={{ padding: 22, marginTop: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <div className="rounded-circle d-flex align-items-center justify-content-center"
              style={{ width: 30, height: 30, background: 'var(--success-soft, #e7f6ec)' }}>
              <i className="bi bi-check-lg" style={{ color: 'var(--success, #1a9e54)', fontSize: '1rem' }} />
            </div>
            <div style={{ fontSize: 15.5, fontWeight: 700, color: 'var(--text-primary)' }}>
              {result.brandLabel} video review files for {prettyDate(result.targetDate)} saved to your Downloads folder
            </div>
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginLeft: 40, marginBottom: 16 }}>
            {result.meta?.candidates ?? 0} creators posted in the window
            {result.missedDates?.length ? ` · missed dates: ${result.missedDates.join(', ')}` : ''}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {FILE_DEFS.map((def) => {
              const count = (result[def.key] || []).length;
              return (
                <div key={def.key} style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '12px 14px', background: 'var(--surface-2)',
                  border: '1px solid var(--border-subtle)', borderRadius: 10,
                }}>
                  <div className="rounded-2 d-flex align-items-center justify-content-center"
                    style={{ width: 34, height: 34, background: 'var(--surface-1)', border: '1px solid var(--border-subtle)' }}>
                    <i className="bi bi-filetype-csv" style={{ color: 'var(--accent)' }} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text-primary)' }}>
                      {result.brandLabel} - {def.ord} video review creators.csv
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>Creators to {def.title}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{count}</div>
                    <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>creator{count === 1 ? '' : 's'}</div>
                  </div>
                  <button className="wx-btn wx-btn-ghost" onClick={() => redownload(def)}
                    title="Download again" style={{ padding: '6px 10px' }}>
                    <i className="bi bi-download" />
                  </button>
                </div>
              );
            })}
          </div>

          {result.needsManual?.length > 0 && (
            <div style={{ marginTop: 14, padding: '12px 14px', border: '1px dashed var(--warning, #d99a2b)', borderRadius: 10, background: 'var(--warning-soft, #fdf6e9)' }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 6 }}>
                <i className="bi bi-flag me-1" /> Needs manual check ({result.needsManual.length})
              </div>
              {result.needsManual.map((m, i) => (
                <div key={i} style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>@{m.handle} — {m.note}</div>
              ))}
            </div>
          )}

          <button className="wx-btn wx-btn-ghost" onClick={reset} style={{ marginTop: 16, fontSize: 13 }}>
            <i className="bi bi-arrow-repeat me-1" /> Run for another date
          </button>
        </div>
      )}

      {/* Non-dismissable processing dialog */}
      {status === 'running' && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 2000,
          background: 'rgba(15,18,24,0.55)', backdropFilter: 'blur(2px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div className="wx-card" style={{ padding: 30, width: 380, maxWidth: '90vw', textAlign: 'center' }}>
            <div className="wx-spinner" style={{ width: 34, height: 34, margin: '0 auto 16px', borderWidth: 3 }} />
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>
              Preparing video review files…
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.6 }}>
              Pulling each creator's full video history from Euka and working out who's due today.
              This can take a minute or two — please keep this tab open.
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 14 }}>
              Target date: <strong>{prettyDate(targetDate)}</strong>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
