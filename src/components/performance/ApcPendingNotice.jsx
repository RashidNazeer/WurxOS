// What an APC's performance month is still waiting on (mig 444): weekly ratings from the
// OL for meetings already held, and TL stars on verified reports. While anything is
// missing the month is not finalised, so both the card and the breakdown say who owes what.
function lines(pending) {
  const out = [];
  if (pending?.unratedMeetings > 0) out.push(`OL: ${pending.unratedMeetings} weekly rating${pending.unratedMeetings === 1 ? '' : 's'} to fill`);
  if (pending?.unstarredReports > 0) out.push(`TL: ${pending.unstarredReports} report${pending.unstarredReports === 1 ? '' : 's'} to star`);
  return out;
}

export function hasPending(pending) {
  return lines(pending).length > 0;
}

// Compact version for the APC card.
export function PendingBadge({ pending }) {
  const l = lines(pending);
  if (!l.length) return null;
  return (
    <div className="rounded-2 px-2 py-1 mb-2" style={{ background: 'var(--warning-soft)', color: 'var(--warning-text)', fontSize: '0.64rem', fontWeight: 600 }}
      title="The score is not final until these are filled. The month is not finalised while anything is missing.">
      <i className="bi bi-exclamation-triangle-fill me-1" />Fill to complete the score — {l.join(' · ')}
    </div>
  );
}

// Full version for the breakdown modal.
export function PendingNotice({ pending, month }) {
  const l = lines(pending);
  if (!l.length) return null;
  return (
    <div className="rounded-2 mb-3 px-3 py-2" style={{ background: 'var(--warning-soft)', border: '1px solid color-mix(in srgb, var(--warning) 30%, transparent)', fontSize: '0.74rem', color: 'var(--warning-text)' }}>
      <div className="fw-bold mb-1"><i className="bi bi-exclamation-triangle-fill me-1" />Score not complete for {month}</div>
      {l.map((x) => <div key={x}>• {x}</div>)}
      <div className="mt-1" style={{ fontSize: '0.68rem' }}>This month stays open and is not finalised until every field is filled.</div>
    </div>
  );
}
