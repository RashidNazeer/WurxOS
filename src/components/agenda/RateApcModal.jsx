import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import WeeklyRatingFields from '../performance/WeeklyRatingFields';
import { markPresented } from '../../lib/agendaApi';

// OL catch-up rating for ONE APC in ONE past meeting, opened from Prior
// Meetings. Two things in one place:
//   1. "Mark as presented" — for the APC who forgot to click Present / was
//      absent (no agenda_presentations row). Record fix only (mig 307).
//   2. The 4-slider weekly CHECKPOINT rating (the audited saveWeeklyRating
//      path) — works whether or not the APC presented.
// OL/Boss only (the caller gates on isOL; the writes are RLS-gated too).

function fmtDate(d) {
  if (!d) return '';
  return new Date(`${d}T00:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

export default function RateApcModal({
  apc, meeting, weekIndex, presented, weeklyEnabled,
  onClose, onChanged, onMarkedPresented,
}) {
  const apcId = apc?.id;
  const [isPresented, setIsPresented] = useState(!!presented);
  const [marking, setMarking] = useState(false);
  const [markErr, setMarkErr] = useState('');

  async function doMarkPresented() {
    if (marking) return;
    setMarking(true); setMarkErr('');
    try {
      await markPresented(meeting.id, apcId);
      setIsPresented(true);
      onMarkedPresented?.();
    } catch (e) {
      setMarkErr(e?.message || String(e));
    } finally {
      setMarking(false);
    }
  }

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 1080, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)' }} onClick={onClose} />
      <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 520, maxHeight: '88vh', zIndex: 1, borderRadius: 14, display: 'flex', flexDirection: 'column' }}>
        {/* header */}
        <div className="d-flex align-items-center justify-content-between px-4 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <div className="min-w-0">
            <div className="fw-bold text-truncate" style={{ fontSize: '0.95rem' }}>Weekly performance — {apc?.display_name || 'APC'}</div>
            <div className="text-muted" style={{ fontSize: '0.72rem' }}>
              {fmtDate(meeting?.meeting_date)}{weekIndex ? ` · Week ${weekIndex}` : ''}
            </div>
          </div>
          <button className="btn btn-sm p-0 px-1" style={{ fontSize: '0.9rem', lineHeight: 1 }} onClick={onClose}>✕</button>
        </div>

        {/* body */}
        <div className="px-4 py-3" style={{ overflowY: 'auto', flexGrow: 1 }}>
          {/* Presented state / mark-as-presented */}
          {isPresented ? (
            <div className="rounded-2 mb-3 px-2 py-2 d-flex align-items-center gap-2"
              style={{ background: 'var(--success-soft)', border: '1px solid color-mix(in srgb, var(--success) 30%, transparent)', fontSize: '0.72rem', color: 'var(--success)' }}>
              <i className="bi bi-check-circle-fill" />
              <span>Marked as presented for this meeting.</span>
            </div>
          ) : (
            <div className="rounded-2 mb-3 px-2 py-2" style={{ background: 'var(--warning-soft)', border: '1px solid color-mix(in srgb, var(--warning) 30%, transparent)' }}>
              <div className="d-flex align-items-start gap-2" style={{ fontSize: '0.72rem', color: 'var(--warning)' }}>
                <i className="bi bi-exclamation-triangle-fill mt-1" />
                <div className="flex-grow-1">
                  <div className="fw-semibold" style={{ color: 'var(--text-primary)' }}>Not marked as presented</div>
                  <div style={{ color: 'var(--text-secondary)' }}>
                    They forgot to click Present or were away. You can still score their week — mark them as presented so it’s on record everywhere.
                  </div>
                  <button className="btn btn-sm mt-2 d-inline-flex align-items-center gap-1"
                    style={{ borderRadius: 8, fontSize: '0.72rem', fontWeight: 700, background: 'var(--warning)', color: 'var(--on-accent, #fff)', border: 'none' }}
                    disabled={marking} onClick={doMarkPresented}>
                    {marking
                      ? <><span className="spinner-border spinner-border-sm" style={{ width: 12, height: 12 }} /> Marking…</>
                      : <><i className="bi bi-check2-circle" /> Mark as presented</>}
                  </button>
                  {markErr && <div className="mt-1" style={{ color: 'var(--danger)' }}><i className="bi bi-exclamation-circle me-1" />{markErr}</div>}
                </div>
              </div>
            </div>
          )}

          {/* The 4-slider checkpoint rating — the audited saveWeeklyRating path */}
          <WeeklyRatingFields apcId={apcId} meetingId={meeting?.id} enabled={weeklyEnabled} onSaved={onChanged} />
        </div>

        {/* footer */}
        <div className="d-flex justify-content-end px-4 py-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <button className="btn btn-sm btn-outline-secondary px-3" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
