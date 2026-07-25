import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { supabase } from '../../lib/supabase';
import { getCompositeFor, getLevel } from '../../lib/performanceApi';
import { tlPerfPreview, listTlDeductions, tlReportDeductRemove } from '../../lib/tlPerfApi';

// How a Team Lead's performance pillar is built: 60% team score (average of the
// TL's APCs' composites) + 40% reporting ((verified reports − deductions) ÷
// reports). Read-only view of the numbers, plus removing a mistaken deduction.
const fmt = (v) => (v == null ? '—' : Math.round(Number(v)));

export default function TlPerfBreakdownModal({ tl, month, enabled, canManage, onClose, onChanged }) {
  const tlId = tl?.id;
  const tlName = tl?.displayName || tl?.name || tl?.userName || 'Team Lead';
  const [preview, setPreview] = useState(null);
  const [apcs, setApcs] = useState([]);
  const [deds, setDeds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [pv, ded, apcRows] = await Promise.all([
        tlPerfPreview(tlId, month),
        listTlDeductions(tlId, month),
        supabase.from('profiles').select('id, display_name').eq('reports_to', tlId).eq('role', 'apc').eq('is_active', true).is('deleted_at', null),
      ]);
      setPreview(pv); setDeds(ded || []);
      const list = apcRows.data || [];
      const withComp = await Promise.all(list.map(async (a) => {
        try { const c = await getCompositeFor(a.id, month); return { id: a.id, name: a.display_name, composite: c?.composite_score ?? null }; }
        catch { return { id: a.id, name: a.display_name, composite: null }; }
      }));
      withComp.sort((x, y) => (y.composite ?? -1) - (x.composite ?? -1));
      setApcs(withComp);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [tlId, month]);
  useEffect(() => { load(); }, [load]);

  async function removeDed(id) {
    setBusy(id);
    try { await tlReportDeductRemove(id); await load(); onChanged?.(); }
    catch (e) { alert(e.message || String(e)); } // eslint-disable-line no-alert
    finally { setBusy(null); }
  }

  const blended = preview?.blended;
  const lvl = blended != null ? getLevel(blended) : null;
  // The reporting score is a 60/40 blend only when BOTH components exist; if one
  // is absent it collapses to the other (so don't show the fixed weights then).
  const bothPresent = preview?.starScore != null && preview?.accountability != null;

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 1080, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)' }} onClick={onClose} />
      <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 560, maxHeight: '88vh', zIndex: 1, borderRadius: 14, display: 'flex', flexDirection: 'column' }}>
        <div className="d-flex align-items-center justify-content-between px-4 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <div>
            <div className="fw-bold" style={{ fontSize: '0.95rem' }}>Team Lead performance — {tlName}</div>
            <div className="text-muted" style={{ fontSize: '0.72rem' }}>{month} · 60% team + 40% reporting</div>
          </div>
          <button className="btn btn-sm p-0 px-1" style={{ fontSize: '0.9rem', lineHeight: 1 }} onClick={onClose}>✕</button>
        </div>

        <div className="px-4 py-3" style={{ overflowY: 'auto', flexGrow: 1 }}>
          {loading ? (
            <div className="text-muted small py-3"><span className="spinner-border spinner-border-sm me-2" />Loading…</div>
          ) : (
            <>
              {/* Blended pillar */}
              <div className="d-flex align-items-center justify-content-between rounded-3 px-3 py-2 mb-3" style={{ background: 'var(--surface-2)' }}>
                <div>
                  <div className="text-muted" style={{ fontSize: '0.64rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    {enabled ? 'Performance pillar (official)' : 'Performance pillar (trial preview)'}
                  </div>
                  <div className="text-muted" style={{ fontSize: '0.68rem' }}>0.6 × team + 0.4 × reporting</div>
                </div>
                {blended != null
                  ? <span className="rounded-pill px-3 py-1" style={{ background: lvl.bg, color: lvl.color, fontSize: '1rem', fontWeight: 800 }}>{blended}/100</span>
                  : <span className="text-muted" style={{ fontSize: '0.8rem', fontWeight: 700 }}>Not rated yet</span>}
              </div>

              {!enabled && (
                <div className="rounded-2 mb-3 px-2 py-1" style={{ background: 'var(--warning-soft)', border: '1px solid color-mix(in srgb, var(--warning) 30%, transparent)', fontSize: '0.68rem', color: 'var(--warning)' }}>
                  <i className="bi bi-flask me-1" />Trial mode — a preview; the TL’s official score still uses the old rating until the Boss switches this to Live.
                </div>
              )}

              {/* Team score */}
              <div className="d-flex align-items-center justify-content-between mb-1">
                <span className="fw-semibold" style={{ fontSize: '0.82rem' }}><i className="bi bi-people me-1 text-primary" />Team score</span>
                <span className="fw-bold" style={{ fontSize: '0.9rem' }}>{fmt(preview?.team)}<span className="text-muted">/100</span></span>
              </div>
              <div className="text-muted mb-2" style={{ fontSize: '0.68rem' }}>Average of {apcs.filter((a) => a.composite != null).length} rated APC{apcs.filter((a) => a.composite != null).length === 1 ? '' : 's'}</div>
              <div className="d-flex flex-column gap-1 mb-3">
                {apcs.length === 0 ? (
                  <div className="text-muted small">No APCs report to this TL.</div>
                ) : apcs.map((a) => (
                  <div key={a.id} className="d-flex align-items-center justify-content-between px-2 py-1 rounded-2" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-subtle)', fontSize: '0.76rem' }}>
                    <span>{a.name}</span>
                    <span className="fw-semibold" style={{ color: a.composite == null ? 'var(--text-muted)' : getLevel(a.composite).color }}>{a.composite == null ? 'Not rated' : `${Math.round(a.composite)}/100`}</span>
                  </div>
                ))}
              </div>

              {/* Reporting = 0.6 OL stars + 0.4 return accountability */}
              <div className="d-flex align-items-center justify-content-between mb-1">
                <span className="fw-semibold" style={{ fontSize: '0.82rem' }}><i className="bi bi-file-earmark-check me-1 text-success" />Reporting score</span>
                <span className="fw-bold" style={{ fontSize: '0.9rem' }}>{preview?.reporting == null ? '—' : `${Math.round(preview.reporting)}/100`}</span>
              </div>
              <div className="text-muted mb-2" style={{ fontSize: '0.66rem' }}>
                {bothPresent ? '0.6 × OL star rating + 0.4 × return accountability' : 'uses whichever component is available this month (the other is absent)'}
              </div>
              <div className="d-flex flex-column gap-1 mb-2">
                <div className="d-flex align-items-center justify-content-between px-2 py-1 rounded-2" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-subtle)', fontSize: '0.76rem' }}>
                  <span><i className="bi bi-star-fill me-1" style={{ color: 'var(--warning)' }} />OL star rating{bothPresent ? ' (60%)' : ''}</span>
                  <span className="fw-semibold">{preview?.starAvg == null ? 'not rated' : `${Number(preview.starAvg).toFixed(1)}★ · ${Math.round(preview.starScore)}/100`}</span>
                </div>
                <div className="d-flex align-items-center justify-content-between px-2 py-1 rounded-2" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-subtle)', fontSize: '0.76rem' }}>
                  <span><i className="bi bi-arrow-counterclockwise me-1 text-muted" />Return accountability{bothPresent ? ' (40%)' : ''}</span>
                  <span className="fw-semibold">{preview?.accountability == null ? 'no reports' : `${Math.round(preview.accountability)}/100`}</span>
                </div>
              </div>
              <div className="text-muted mb-2" style={{ fontSize: '0.66rem' }}>
                {preview?.n || 0} report{(preview?.n || 0) === 1 ? '' : 's'} verified · {Number(preview?.deductions || 0)} mark{Number(preview?.deductions || 0) === 1 ? '' : 's'} deducted
              </div>
              {deds.length === 0 ? (
                <div className="text-muted small">No deductions this month.</div>
              ) : (
                <div className="d-flex flex-column gap-1">
                  {deds.map((d) => (
                    <div key={d.id} className="d-flex align-items-center justify-content-between px-2 py-1 rounded-2" style={{ background: 'var(--danger-soft)', border: '1px solid color-mix(in srgb, var(--danger) 25%, transparent)', fontSize: '0.74rem' }}>
                      <div className="min-w-0">
                        <span className="fw-semibold" style={{ color: 'var(--danger)' }}>−{Number(d.amount)}</span>
                        <span className="text-muted"> · {d.report?.brand?.brand_name || 'report'}{d.report?.period_label ? ` (${d.report.period_label})` : ''}</span>
                        {d.note && <span className="text-muted"> — {d.note}</span>}
                      </div>
                      {canManage && (
                        <button className="btn btn-sm p-0 px-1" style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }} disabled={busy === d.id} onClick={() => removeDed(d.id)} title="Remove this deduction">
                          {busy === d.id ? <span className="spinner-border spinner-border-sm" style={{ width: 10, height: 10 }} /> : <i className="bi bi-x-lg" />}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div className="d-flex justify-content-end px-4 py-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <button className="btn btn-sm btn-outline-secondary px-3" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
