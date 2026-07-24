import { useEffect, useState } from 'react';
import { listCheckpointReturns, getCheckpointParties } from '../../lib/checkpointsApi';
import { useAuth } from '../../contexts/AuthContext';
import { fmtPktStamp } from '../../utils/pktTime';

// Shows whoever now holds a returned checkpoint WHY it came back — reliably, in
// BOTH the edit form and the read-only view (the report system learned the hard
// way that a status-gated inline note gets hidden; migs 203/215). Reads the
// append-only checkpoint_returns log (mig 268) so the reason, who and when are
// always visible, with full history. Renders nothing when there are no returns.

const STATUS_LABEL = { draft: 'Draft', submitted: 'Pending TL', verified: 'Pending OL', approved: 'Approved' };

// Who a return landed on, worded for the VIEWER. `to_status`: 'draft' → the APC
// author, 'submitted' → the brand's TL. Returns a short phrase (no leading cap).
function recipientLabel(toStatus, parties, viewerId, viewerRole) {
  const { apc, tl } = parties;
  if (toStatus === 'draft') {
    if (apc && viewerId && apc.id === viewerId) return 'you';
    if (viewerRole === 'tl' || viewerRole === 'pctl') return apc ? `your team member ${apc.name}` : 'the team member';
    return apc ? `${apc.name} (APC)` : 'the APC';
  }
  if (toStatus === 'submitted') {
    if (tl && viewerId && tl.id === viewerId) return 'you';
    if (apc && viewerId && apc.id === viewerId) return tl ? `your team lead ${tl.name}` : 'your team lead';
    return tl ? `${tl.name} (Team Lead)` : 'the Team Lead';
  }
  return STATUS_LABEL[toStatus] || toStatus;
}

export default function CheckpointReturnNotice({ checkpointId, status }) {
  const { user, profile } = useAuth();
  const viewerId = user?.id;
  const viewerRole = profile?.role || '';
  const [returns, setReturns] = useState([]);
  const [parties, setParties] = useState({ apc: null, tl: null });
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!checkpointId) { setReturns([]); setParties({ apc: null, tl: null }); return undefined; }
    listCheckpointReturns(checkpointId)
      .then((r) => { if (!cancelled) setReturns(r || []); })
      .catch(() => { if (!cancelled) setReturns([]); });
    getCheckpointParties(checkpointId)
      .then((p) => { if (!cancelled) setParties(p || { apc: null, tl: null }); })
      .catch(() => { if (!cancelled) setParties({ apc: null, tl: null }); });
    return () => { cancelled = true; };
  }, [checkpointId, status]);

  if (!returns.length) return null;

  const latest = returns[0];                 // newest first
  const ordered = [...returns].reverse();     // chronological for "#1, #2…"
  // Prominent banner only while the checkpoint still sits where it was returned.
  const active = latest.to_status === status && status !== 'approved';

  return (
    <div style={{ marginBottom: 14 }}>
      {active && (
        <div style={{ borderRadius: 12, padding: 14, background: 'var(--danger-soft)', border: '1px solid color-mix(in srgb, var(--danger) 40%, transparent)' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
            <i className="bi bi-arrow-counterclockwise" style={{ color: 'var(--danger)', fontSize: '1.05rem', marginTop: 1 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 800, color: 'var(--danger)', fontSize: '0.92rem' }}>Checkpoint Returned</span>
                <span style={{ borderRadius: 999, padding: '2px 9px', background: 'var(--surface-1)', color: 'var(--text-secondary)', fontSize: '0.62rem', fontWeight: 700, border: '1px solid var(--border-subtle)' }}>
                  Now: {STATUS_LABEL[status] || status}
                </span>
              </div>
              <div style={{ color: 'var(--text-muted)', marginTop: 4, fontSize: '0.76rem' }}>
                Returned by <strong style={{ color: 'var(--text-primary)' }}>{latest.by?.display_name || 'a reviewer'}</strong>
                {' · to '}
                <strong style={{ color: 'var(--text-primary)' }}>{recipientLabel(latest.to_status, parties, viewerId, viewerRole)}</strong>
                {' · '}{fmtPktStamp(latest.returned_at)} PKT
              </div>
              <div style={{ borderRadius: 8, marginTop: 8, padding: '8px 12px', background: 'var(--surface-1)', border: '1px solid var(--border-subtle)' }}>
                <div style={{ fontWeight: 700, marginBottom: 3, fontSize: '0.64rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)' }}>Reason</div>
                <div style={{ fontSize: '0.86rem', color: 'var(--text-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {latest.note ? latest.note : <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>No reason was provided.</span>}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {(returns.length > 1 || !active) && (
        <div style={{ marginTop: active ? 8 : 0 }}>
          <button type="button" onClick={() => setShowHistory((v) => !v)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'transparent', border: 'none', color: 'var(--text-secondary)', fontSize: '0.76rem', fontWeight: 600, padding: '2px 4px', cursor: 'pointer' }}>
            <i className={`bi ${showHistory ? 'bi-chevron-down' : 'bi-chevron-right'}`} style={{ fontSize: '0.7rem' }} />
            Return history ({returns.length})
          </button>
          {showHistory && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
              {ordered.map((r, i) => (
                <div key={r.id} style={{ borderRadius: 8, padding: '8px 12px', background: 'var(--surface-2)', border: '1px solid var(--border-subtle)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 600, fontSize: '0.78rem', color: 'var(--text-primary)' }}>
                      Return #{i + 1}
                      <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> · to {recipientLabel(r.to_status, parties, viewerId, viewerRole)}</span>
                    </span>
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>
                      by {r.by?.display_name || 'reviewer'} · {fmtPktStamp(r.returned_at)} PKT
                    </span>
                  </div>
                  {r.note && <div style={{ marginTop: 4, fontSize: '0.8rem', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{r.note}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
