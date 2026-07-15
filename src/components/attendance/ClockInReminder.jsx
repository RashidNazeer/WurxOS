import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { shouldRemindClockIn, onActiveRecord } from '../../lib/attendanceApi';

// "You forgot to clock in" reminder.
//
// A global, centered popup that appears an hour after a user's shift start if
// they still haven't clocked in. ALL the decision logic — shift start, the 3pm
// shift-day rollover, weekend / holiday / leave suppression, the timing window
// — lives in one DB function (mig 254, attendance_should_remind_clock_in). This
// component only asks "should I show?" and honours a per-shift-day dismissal.
//
// It never fires for Boss or for anyone who hasn't set a shift start: those are
// short-circuited here (no shift → no polling) and again in the DB, so the
// default for everyone is silence.

const POLL_MS = 120000;               // re-check every 2 min
const SOFT_HIDE_MS = 10 * 60000;      // backdrop tap hides it for 10 min, then it may return
const CLOCKIN_GRACE_MS = 5 * 60000;   // after "Clock in now", wait 5 min before re-nagging
const DISMISS_KEY = (uid) => `wurxos:clockInReminderDismissed:${uid}`;

function fmtShiftTime(t) {
  if (!t) return '';
  const [h, m] = String(t).split(':');
  let hh = Number(h); const ap = hh >= 12 ? 'PM' : 'AM'; hh = hh % 12 || 12;
  return `${hh}:${m} ${ap}`;
}

function readDismissed(uid) {
  try { return localStorage.getItem(DISMISS_KEY(uid)) || ''; } catch { return ''; }
}
function writeDismissed(uid, shiftDay) {
  try { localStorage.setItem(DISMISS_KEY(uid), shiftDay); } catch { /* private mode */ }
}

export default function ClockInReminder() {
  const { user, profile } = useAuth();
  const uid = user?.id;
  const role = profile?.role || '';
  // Only people who opted in by setting a shift start ever poll. Boss never clocks in.
  const eligible = !!uid && role !== 'boss' && !!profile?.shift_start_time;

  const [verdict, setVerdict] = useState(null);   // { remind, reason, shift_start, shift_day }
  // A TRANSIENT soft-hide (backdrop tap / "Clock in now"): the epoch-ms until
  // which the popup stays hidden. It lapses on its own so a genuine
  // forgot-to-clock-in resurfaces — unlike "Dismiss for today", which persists.
  const [softHideUntil, setSoftHideUntil] = useState(0);
  const navigate = useNavigate();
  const pollRef = useRef(null);

  const check = useCallback(async () => {
    if (!eligible) { setVerdict(null); return; }
    try { setVerdict(await shouldRemindClockIn()); }
    catch { /* keep last known; a failed check must never surface a false alarm */ }
  }, [eligible]);

  // Poll on mount, on an interval, and whenever the tab regains focus.
  useEffect(() => {
    if (!eligible) { setVerdict(null); return undefined; }
    check();
    pollRef.current = setInterval(check, POLL_MS);
    const onFocus = () => check();
    window.addEventListener('focus', onFocus);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      window.removeEventListener('focus', onFocus);
    };
  }, [eligible, check]);

  // Re-check the instant their attendance changes (e.g. they clock in), so the
  // popup closes immediately rather than after the next poll.
  useEffect(() => {
    if (!eligible) return undefined;
    const unsub = onActiveRecord(uid, () => check());
    return () => unsub();
  }, [eligible, uid, check]);

  if (!eligible || !verdict?.remind) return null;
  if (Date.now() < softHideUntil) return null;                       // transient hide, still active
  if (readDismissed(uid) === String(verdict.shift_day)) return null; // dismissed for the whole shift-day

  // Explicit "Dismiss for today" — persisted, stays gone all shift-day even across reloads.
  const dismiss = () => {
    writeDismissed(uid, String(verdict.shift_day));
    setSoftHideUntil(Date.now() + SOFT_HIDE_MS);   // hide immediately; the persisted flag holds it
  };
  // Backdrop click — a soft, self-lapsing hide, NOT the persistent dismiss, so
  // an accidental outside-tap can't silence a genuine forgot-to-clock-in: it
  // returns on the next poll after SOFT_HIDE_MS.
  const softHide = () => setSoftHideUntil(Date.now() + SOFT_HIDE_MS);

  const goClockIn = () => {
    // Hide briefly while they go clock in; if they don't, it re-nags after the
    // grace. The moment they DO clock in, onActiveRecord → check → remind=false.
    setSoftHideUntil(Date.now() + CLOCKIN_GRACE_MS);
    navigate('/attendance');
  };

  return createPortal(
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1200, display: 'flex',
      alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div
        style={{ position: 'absolute', inset: 0, background: 'rgba(15,23,42,0.55)', backdropFilter: 'blur(3px)' }}
        onClick={softHide}
      />
      <div className="card border-0 shadow-lg"
        style={{ position: 'relative', width: '100%', maxWidth: 420, zIndex: 1, borderRadius: 16,
                 background: 'var(--surface-1)', border: '1px solid var(--border-subtle)' }}>
        <div className="card-body p-4 text-center">
          <div className="rounded-circle d-inline-flex align-items-center justify-content-center mb-3"
            style={{ width: 60, height: 60, background: 'var(--warning-soft)' }}>
            <i className="bi bi-alarm" style={{ fontSize: '1.7rem', color: 'var(--warning)' }} />
          </div>
          <h5 className="fw-bold mb-1" style={{ color: 'var(--text-primary)' }}>Don’t forget to clock in</h5>
          <p className="text-muted mb-4" style={{ fontSize: '0.9rem' }}>
            Your shift started at <strong style={{ color: 'var(--text-primary)' }}>{fmtShiftTime(verdict.shift_start)} PKT</strong> and
            you haven’t clocked in yet. Tap below to start your shift.
          </p>
          <div className="d-flex flex-column gap-2">
            <button className="btn btn-success w-100 d-inline-flex align-items-center justify-content-center gap-2"
              style={{ borderRadius: 12, fontWeight: 700, padding: '11px 16px' }}
              onClick={goClockIn}>
              <i className="bi bi-box-arrow-in-right" style={{ fontSize: '1.1rem' }} />
              Clock in now
            </button>
            <button className="btn btn-link text-decoration-none text-muted"
              style={{ fontSize: '0.82rem' }}
              onClick={dismiss}>
              Dismiss for today
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
