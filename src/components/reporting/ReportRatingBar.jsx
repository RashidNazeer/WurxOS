import { useEffect, useState } from 'react';
import { rateApcReport, rateTlReport, getReportTlNote } from '../../lib/reportsApi';

// Half-star picker (0–5, 0.5 steps): left half of a star = x.5, right half = x.
// Matches the agenda OngoingEvaluation StarRating look.
function StarPicker({ value, onChange, disabled }) {
  const v = Number(value) || 0;
  // preventDefault on mousedown so clicking a star does NOT blur a focused note
  // textarea first (which would fire a stale star write — the blur/click race).
  const noBlur = (e) => e.preventDefault();
  return (
    <div className="d-flex align-items-center gap-1">
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} style={{ position: 'relative', display: 'inline-block', width: '1.15rem', height: '1.15rem', cursor: disabled ? 'default' : 'pointer' }}>
          <i className={`bi ${v >= i ? 'bi-star-fill' : v >= i - 0.5 ? 'bi-star-half' : 'bi-star'}`}
            style={{ color: 'var(--warning, #f59e0b)', fontSize: '1.15rem', position: 'absolute', inset: 0, lineHeight: 1, opacity: disabled ? 0.55 : 1 }} />
          {!disabled && <>
            <span onMouseDown={noBlur} onClick={() => onChange(i - 0.5)} title={`${i - 0.5} stars`} style={{ position: 'absolute', left: 0, top: 0, width: '50%', height: '100%', zIndex: 1 }} />
            <span onMouseDown={noBlur} onClick={() => onChange(i)} title={`${i} stars`} style={{ position: 'absolute', right: 0, top: 0, width: '50%', height: '100%', zIndex: 1 }} />
          </>}
        </span>
      ))}
    </div>
  );
}

// One rating row: label + stars, plus an OPTIONAL justification note. Editable
// (optimistic save) or, when `readOnly`, a view-only display of whoever set it.
// The star and the note save together via onSave(stars, note); a null star means
// "note-only" (the RPC leaves the star untouched).
function RatingRow({ label, hint, value, note, onSave, readOnly = false, withNote = false, notePlaceholder }) {
  const [stars, setStars] = useState(value ?? null);
  const [noteText, setNoteText] = useState(note ?? '');
  const [state, setState] = useState('idle');
  useEffect(() => { setStars(value ?? null); }, [value]);
  useEffect(() => { setNoteText(note ?? ''); }, [note]);

  async function save(nextStars, nextNote) {
    setState('saving');
    try { await onSave(nextStars, nextNote); setState('saved'); setTimeout(() => setState('idle'), 1600); }
    catch { setState('error'); }
  }
  async function pick(v) {
    if (readOnly) return;
    setStars(v);
    await save(v, noteText);
  }
  function saveNote() {
    if (readOnly) return;
    if ((note ?? '') === noteText) return; // unchanged — don't re-save on every blur
    save(stars, noteText);
  }

  return (
    <div className="rounded-2 px-2 py-2" style={{ background: 'var(--surface-2)', border: '1px solid var(--border-subtle)' }}>
      <div className="d-flex align-items-center justify-content-between flex-wrap gap-2">
        <div>
          <div style={{ fontSize: '0.74rem', fontWeight: 700, color: 'var(--text-secondary)' }}>{label}</div>
          {hint && <div className="text-muted" style={{ fontSize: '0.64rem' }}>{hint}</div>}
        </div>
        <div className="d-flex align-items-center gap-2">
          <StarPicker value={stars} onChange={pick} disabled={readOnly} />
          <span style={{ fontSize: '0.66rem', minWidth: 52, textAlign: 'right', color: state === 'error' ? 'var(--danger)' : 'var(--text-muted)' }}>
            {readOnly
              ? (stars != null ? <strong style={{ color: 'var(--text-secondary)' }}>{stars}/5</strong> : <span>not rated</span>)
              : (<>
                  {state === 'saving' && <><span className="spinner-border spinner-border-sm me-1" style={{ width: 10, height: 10 }} />…</>}
                  {state === 'saved' && <><i className="bi bi-check-circle-fill me-1 text-success" />Saved</>}
                  {state === 'error' && <><i className="bi bi-exclamation-triangle me-1" />Failed</>}
                  {state === 'idle' && stars != null && <span>{stars}/5</span>}
                </>)}
          </span>
        </div>
      </div>

      {/* Editable note (the rater) */}
      {withNote && !readOnly && (
        <textarea className="form-control form-control-sm mt-2" rows={2}
          style={{ borderRadius: 8, fontSize: '0.78rem' }}
          placeholder={notePlaceholder}
          value={noteText}
          onChange={(e) => setNoteText(e.target.value)}
          onBlur={saveNote} />
      )}

      {/* Read-only note (the recipient) */}
      {readOnly && noteText && (
        <div className="rounded-2 px-2 py-1 mt-2 d-flex align-items-start gap-2"
          style={{ background: 'var(--surface-1)', border: '1px solid var(--border-subtle)', fontSize: '0.76rem', color: 'var(--text-secondary)' }}>
          <i className="bi bi-chat-left-quote text-muted mt-1" style={{ fontSize: '0.72rem' }} />
          <span style={{ whiteSpace: 'pre-wrap' }}>{noteText}</span>
        </div>
      )}
    </div>
  );
}

// Reporting stars on a report's detail panel (mig 303). Shown only to the reviewer
// entitled to rate at the report's current stage:
//   • APC star  — the brand-owner TL (or OL/Boss) rates once VERIFIED/approved →
//                 feeds the APC author's external-report score.
//   • TL  star  — the OL/Boss rates from the verified stage → feeds the TL's
//                 reporting score, with an OPTIONAL justification note (mig 309/310).
// The note is fetched from the scoped report_tl_stars_notes table (RLS: OL/Boss +
// the brand-owner TL only) so it never rides in the report payload. The receiving
// brand-owner TL sees their star + the note read-only.
export default function ReportRatingBar({ report, viewerRole, isBrandOwner, onRated }) {
  const isAdmin = viewerRole === 'ol' || viewerRole === 'boss' || viewerRole === 'developer';
  const isBoss = viewerRole === 'boss';
  const status = report?.status || 'draft';
  const rateable = status === 'verified' || status === 'approved';
  const canRateApc = (isBrandOwner || isBoss) && rateable;
  const showApcReadonly = !canRateApc && isAdmin && rateable;
  const canRateTl = isAdmin && rateable;
  const tlReadonlyBase = !isAdmin && isBrandOwner && rateable; // the receiving TL

  // Fetch the OL's note only when this viewer is entitled to see it (OL/Boss, or
  // the brand-owner TL) — RLS also enforces it server-side.
  const [tlNote, setTlNote] = useState(null);
  const reportId = report?.id;
  const wantsNote = !!reportId && (canRateTl || tlReadonlyBase);
  useEffect(() => {
    if (!wantsNote) { setTlNote(null); return undefined; }
    let cancelled = false;
    getReportTlNote(reportId).then((n) => { if (!cancelled) setTlNote(n); }).catch(() => {});
    return () => { cancelled = true; };
  }, [wantsNote, reportId]);

  if (!report) return null;
  const showTlReadonly = tlReadonlyBase && (report.tl_stars != null || !!tlNote);
  if (!canRateApc && !showApcReadonly && !canRateTl && !showTlReadonly) return null;

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
      {showApcReadonly && (
        <RatingRow
          label="Report quality (APC)"
          hint="The Team Lead's rating of this report (feeds the APC's score) — view only."
          value={report.apc_stars}
          readOnly
        />
      )}
      {canRateTl && (
        <RatingRow
          label="TL reporting"
          hint="Your 0–5★ feeds the Team Lead's reporting score. Add an optional note to justify it — the TL will see it."
          value={report.tl_stars}
          note={tlNote}
          withNote
          notePlaceholder="Optional comment for the Team Lead — justify this rating…"
          onSave={async (stars, note) => {
            await rateTlReport(report.id, stars, note);
            setTlNote((note || '').trim() || null);
            onRated?.({ ...report, tl_stars: stars ?? report.tl_stars ?? null });
          }}
        />
      )}
      {showTlReadonly && (
        <RatingRow
          label="TL reporting"
          hint="The OL's rating of your report (feeds your reporting score)."
          value={report.tl_stars}
          note={tlNote}
          readOnly
        />
      )}
    </div>
  );
}
