import React, { useEffect, useState } from 'react';
import { listReportReturns } from '../../lib/reportsApi';
import { fmtPktStamp } from '../../utils/pktTime';

// Shows the person now holding a returned report WHY it came back — generic at
// every approval level (APC←TL, TL←OL, …). A prominent "Report Returned" panel
// (reason · who · when · status) when the report is currently sitting at the
// stage it was returned to, plus the full return history. Reads the append-only
// report_returns log (mig 203). Renders nothing when there are no returns
// (or for the anonymous client portal, which can't read the log).

const STATUS_LABEL = { draft: 'Draft', submitted: 'Pending TL', verified: 'Pending OL', approved: 'Approved' };

export default function ReportReturnNotice({ report }) {
  const reportId = report?.id;
  const status = report?.status;
  const [returns, setReturns] = useState([]);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!reportId) { setReturns([]); return undefined; }
    listReportReturns(reportId)
      .then((r) => { if (!cancelled) setReturns(r || []); })
      .catch(() => { if (!cancelled) setReturns([]); });
    return () => { cancelled = true; };
  }, [reportId, status]);

  if (!returns.length) return null;

  const latest = returns[0];                       // newest first
  const ordered = [...returns].reverse();          // chronological for "#1, #2…"
  // Prominent "needs your attention" banner only while the report is still
  // sitting where it was returned to (not yet moved forward / approved).
  const active = latest.to_status === status && status !== 'approved';

  return (
    <div className="mb-3">
      {active && (
        <div className="rounded-3 p-3" style={{
          background: 'var(--danger-soft)',
          border: '1px solid color-mix(in srgb, var(--danger) 40%, transparent)',
        }}>
          <div className="d-flex align-items-start gap-2">
            <i className="bi bi-arrow-counterclockwise" style={{ color: 'var(--danger)', fontSize: '1.05rem', marginTop: 1 }} />
            <div className="flex-grow-1 min-w-0">
              <div className="d-flex align-items-center gap-2 flex-wrap">
                <span className="fw-bold" style={{ color: 'var(--danger)', fontSize: '0.9rem' }}>Report Returned</span>
                <span className="rounded-pill px-2 py-1" style={{ background: 'var(--surface-1)', color: 'var(--text-secondary)', fontSize: '0.62rem', fontWeight: 700, border: '1px solid var(--border-subtle)' }}>
                  Now: {STATUS_LABEL[status] || status}
                </span>
              </div>
              <div className="text-muted mt-1" style={{ fontSize: '0.74rem' }}>
                Returned by <strong style={{ color: 'var(--text-primary)' }}>{latest.by?.display_name || 'a reviewer'}</strong>
                {' · '}{fmtPktStamp(latest.returned_at)} PKT
              </div>
              <div className="rounded-2 mt-2 px-3 py-2" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-subtle)' }}>
                <div className="fw-semibold mb-1" style={{ fontSize: '0.66rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)' }}>Reason</div>
                <div style={{ fontSize: '0.84rem', color: 'var(--text-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {latest.note ? latest.note : <span className="text-muted fst-italic">No reason was provided.</span>}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {(returns.length > 1 || !active) && (
        <div className={active ? 'mt-2' : ''}>
          <button type="button" onClick={() => setShowHistory((v) => !v)}
            className="btn btn-sm d-inline-flex align-items-center gap-1"
            style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', fontSize: '0.74rem', fontWeight: 600, padding: '2px 4px' }}>
            <i className={`bi ${showHistory ? 'bi-chevron-down' : 'bi-chevron-right'}`} style={{ fontSize: '0.7rem' }} />
            Return history ({returns.length})
          </button>
          {showHistory && (
            <div className="d-flex flex-column gap-2 mt-1">
              {ordered.map((r, i) => (
                <div key={r.id} className="rounded-2 px-3 py-2" style={{ background: 'var(--surface-2)', border: '1px solid var(--border-subtle)' }}>
                  <div className="d-flex align-items-center justify-content-between gap-2 flex-wrap">
                    <span className="fw-semibold" style={{ fontSize: '0.76rem', color: 'var(--text-primary)' }}>
                      Return #{i + 1}
                      <span className="text-muted fw-normal"> · {STATUS_LABEL[r.from_status] || r.from_status} → {STATUS_LABEL[r.to_status] || r.to_status}</span>
                    </span>
                    <span className="text-muted" style={{ fontSize: '0.68rem' }}>
                      {r.by?.display_name || 'reviewer'} · {fmtPktStamp(r.returned_at)} PKT
                    </span>
                  </div>
                  {r.note && <div className="mt-1" style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{r.note}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
