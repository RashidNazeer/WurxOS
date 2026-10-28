// Per-Team-Lead progress on a request that needs several Team Leads (an APC whose
// brands span 2+ teams, mig 428). Renders nothing for an ordinary single-chain
// request. Shown to everyone who can see the request, approved ones included, so
// each lead can see which of THEIR brands the absence covers.
const STATE = {
  approved:   { icon: 'bi-check-circle-fill', color: 'var(--success-text)', bg: 'var(--success-soft)', word: 'Approved' },
  rejected:   { icon: 'bi-x-circle-fill',     color: 'var(--danger-text)',  bg: 'var(--danger-soft)',  word: 'Rejected' },
  pending:    { icon: 'bi-hourglass-split',   color: 'var(--warning-text)', bg: 'var(--warning-soft)', word: 'Waiting' },
  superseded: { icon: 'bi-dash-circle',       color: 'var(--text-muted)',   bg: 'var(--surface-2)',    word: 'Not needed' },
};

export default function ApproverChips({ approvers, meId = null }) {
  if (!approvers || approvers.length === 0) return null;
  return (
    <div className="mt-2">
      <div className="text-muted" style={{ fontSize: '0.65rem', fontWeight: 600, marginBottom: 4 }}>
        Needs every Team Lead — this request is one request, counted once
      </div>
      <div className="d-flex flex-wrap gap-1">
        {approvers.map((a) => {
          const st = STATE[a.decision] || STATE.pending;
          const names = (a.brands || []).map((b) => b.name).join(', ');
          return (
            <span key={a.approverId} className="d-inline-flex align-items-center gap-1 rounded-pill px-2 py-1"
              style={{ background: st.bg, color: st.color, fontSize: '0.65rem', fontWeight: 600 }}
              title={a.note ? `“${a.note}”` : undefined}>
              <i className={`bi ${st.icon}`} style={{ fontSize: '0.58rem' }} />
              {a.name}{a.approverId === meId ? ' (you)' : ''} · {st.word}
              {names && <span style={{ fontWeight: 500, opacity: 0.85 }}> — {names}</span>}
            </span>
          );
        })}
      </div>
    </div>
  );
}
