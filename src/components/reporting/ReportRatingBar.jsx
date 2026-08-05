import { useEffect, useState } from 'react';
import { rateApcReport, rateTlReport } from '../../lib/reportsApi';

// Half-star picker (0–5, 0.5 steps): left half of a star = x.5, right half = x.
// Matches the agenda OngoingEvaluation StarRating look.
function StarPicker({ value, onChange, disabled }) {
  const v = Number(value) || 0;
  return (
    <div className="d-flex align-items-center gap-1">
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} style={{ position: 'relative', display: 'inline-block', width: '1.15rem', height: '1.15rem', cursor: disabled ? 'default' : 'pointer' }}>
          <i className={`bi ${v >= i ? 'bi-star-fill' : v >= i - 0.5 ? 'bi-star-half' : 'bi-star'}`}
            style={{ color: 'var(--warning, #f59e0b)', fontSize: '1.15rem', position: 'absolute', inset: 0, lineHeight: 1, opacity: disabled ? 0.55 : 1 }} />
          {!disabled && <>
            <span onClick={() => onChange(i - 0.5)} title={`${i - 0.5} stars`} style={{ position: 'absolute', left: 0, top: 0, width: '50%', height: '100%', zIndex: 1 }} />
            <span onClick={() => onChange(i)} title={`${i} stars`} style={{ position: 'absolute', right: 0, top: 0, width: '50%', height: '100%', zIndex: 1 }} />
          </>}
        </span>
      ))}
    </div>
  );
}

// One rating row (label + stars + save state), with an optimistic save.
function RatingRow({ label, hint, value, onSave }) {
  const [stars, setStars] = useState(value ?? null);
  const [state, setState] = useState('idle');
  useEffect(() => { setStars(value ?? null); }, [value]);
  async function pick(v) {
    setStars(v); setState('saving');
    try { await onSave(v); setState('saved'); setTimeout(() => setState('idle'), 1600); }
    catch { setState('error'); }
  }
  return (
    <div className="d-flex align-items-center justify-content-between flex-wrap gap-2 rounded-2 px-2 py-2"
      style={{ background: 'var(--surface-2)', border: '1px solid var(--border-subtle)' }}>
      <div>
        <div style={{ fontSize: '0.74rem', fontWeight: 700, color: 'var(--text-secondary)' }}>{label}</div>
        {hint && <div className="text-muted" style={{ fontSize: '0.64rem' }}>{hint}</div>}
      </div>
      <div className="d-flex align-items-center gap-2">
        <StarPicker value={stars} onChange={pick} />
        <span style={{ fontSize: '0.66rem', minWidth: 46, color: state === 'error' ? 'var(--danger)' : 'var(--text-muted)' }}>
          {state === 'saving' && <><span className="spinner-border spinner-border-sm me-1" style={{ width: 10, height: 10 }} />…</>}
          {state === 'saved' && <><i className="bi bi-check-circle-fill me-1 text-success" />Saved</>}
          {state === 'error' && <><i className="bi bi-exclamation-triangle me-1" />Failed</>}
          {state === 'idle' && stars != null && <span>{stars}/5</span>}
        </span>
      </div>
    </div>
  );
}

// Reporting stars on a report's detail panel (mig 303). Shown only to the reviewer
// who is entitled to rate at the report's current stage:
//   • APC star  — the brand-owner TL (or OL/Boss) rates once the report is VERIFIED
//                 or approved → feeds the APC author's external-report score.
//   • TL  star  — the OL/Boss rates once the report is APPROVED → feeds the TL's
//                 reporting score.
// Read-only for everyone else (no picker rendered).
export default function ReportRatingBar({ report, viewerRole, isBrandOwner, onRated }) {
  if (!report) return null;
  const isAdmin = viewerRole === 'ol' || viewerRole === 'boss' || viewerRole === 'developer';
  const isBoss = viewerRole === 'boss';
  const status = report.status || 'draft';
  const rateable = status === 'verified' || status === 'approved';
  // The APC star is the Team Lead's (verifier's) job — shown to the brand-owner TL
  // (+ Boss as super-admin), NOT to the OL, whose job is the TL star below.
  const canRateApc = (isBrandOwner || isBoss) && rateable;
  // The TL star is the OL's job at approval — available from the verified stage
  // (when the report is on the OL's desk for approval), through approved.
  const canRateTl = isAdmin && rateable;
  if (!canRateApc && !canRateTl) return null;

  return (
    <div className="d-flex flex-column gap-2 mt-2">
      {canRateApc && (
        <RatingRow
          label="Report quality (APC)"
          hint="Your 0–5★ on this report feeds the APC's external-reporting score."
          value={report.apc_stars}
          onSave={async (v) => { await rateApcReport(report.id, v); onRated?.({ ...report, apc_stars: v }); }}
        />
      )}
      {canRateTl && (
        <RatingRow
          label="TL reporting"
          hint="Your 0–5★ on this approved report feeds the Team Lead's reporting score."
          value={report.tl_stars}
          onSave={async (v) => { await rateTlReport(report.id, v); onRated?.({ ...report, tl_stars: v }); }}
        />
      )}
    </div>
  );
}
