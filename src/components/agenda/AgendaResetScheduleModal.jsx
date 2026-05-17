import React, { useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import {
  getAgendaResetSchedule, updateAgendaResetSchedule,
  DEFAULT_AGENDA_RESET, formatAgendaResetHint,
} from '../../lib/agendaApi';

// Per-user agenda task reset cadence. All of a user's agenda tasks
// reset together on this schedule (status → To Do, due date advances).

const DOW = [
  [1, 'Monday'], [2, 'Tuesday'], [3, 'Wednesday'], [4, 'Thursday'],
  [5, 'Friday'], [6, 'Saturday'], [0, 'Sunday'],
];
const CADENCES = [
  ['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly'],
];

export default function AgendaResetScheduleModal({ onClose, onSaved }) {
  const { user } = useAuth();
  const [sched, setSched]   = useState(DEFAULT_AGENDA_RESET);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');

  useEffect(() => {
    let cancelled = false;
    getAgendaResetSchedule(user?.id)
      .then((s) => { if (!cancelled) setSched(s); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [user?.id]);

  function patch(part) { setSched((s) => ({ ...s, ...part })); }
  function patchBlock(key, part) { setSched((s) => ({ ...s, [key]: { ...s[key], ...part } })); }

  async function handleSave() {
    setSaving(true);
    setError('');
    try {
      await updateAgendaResetSchedule(user?.id, sched);
      onSaved?.();
      onClose();
    } catch (e) {
      setError(e.message || 'Failed to save.');
    } finally {
      setSaving(false);
    }
  }

  const cadence = sched.cadence || 'weekly';

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1070, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(2px)' }} onClick={onClose} />
      <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 440, zIndex: 1, borderRadius: 14 }}>
        <div className="card-body p-4">
          <p className="fw-semibold mb-1">Agenda task reset schedule</p>
          <p className="text-muted mb-3" style={{ fontSize: '0.78rem' }}>
            When your agenda tasks reset back to “To Do” and roll to the next cycle.
          </p>

          {error && <div className="alert alert-danger py-2 small mb-3">{error}</div>}

          {loading ? (
            <div className="text-muted small py-3"><span className="spinner-border spinner-border-sm me-2" />Loading…</div>
          ) : (
            <>
              <div className="mb-3">
                <label className="form-label small fw-semibold">Cadence</label>
                <div className="d-flex gap-2">
                  {CADENCES.map(([v, l]) => (
                    <button key={v} type="button"
                      className={`btn btn-sm ${cadence === v ? 'btn-dark' : 'btn-outline-secondary'}`}
                      style={{ borderRadius: 8, fontSize: '0.78rem' }}
                      onClick={() => patch({ cadence: v })}>
                      {l}
                    </button>
                  ))}
                </div>
              </div>

              {cadence === 'daily' && (
                <div className="mb-3">
                  <label className="form-label small fw-semibold">Reset time</label>
                  <input type="time" className="form-control form-control-sm" style={{ borderRadius: 8, maxWidth: 160 }}
                    value={sched.daily?.time || '00:00'}
                    onChange={(e) => patchBlock('daily', { time: e.target.value })} />
                </div>
              )}

              {cadence === 'weekly' && (
                <div className="row g-2 mb-3">
                  <div className="col-7">
                    <label className="form-label small fw-semibold">Reset day</label>
                    <select className="form-select form-select-sm" style={{ borderRadius: 8 }}
                      value={sched.weekly?.dayOfWeek ?? 1}
                      onChange={(e) => patchBlock('weekly', { dayOfWeek: Number(e.target.value) })}>
                      {DOW.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </div>
                  <div className="col-5">
                    <label className="form-label small fw-semibold">Time</label>
                    <input type="time" className="form-control form-control-sm" style={{ borderRadius: 8 }}
                      value={sched.weekly?.time || '00:00'}
                      onChange={(e) => patchBlock('weekly', { time: e.target.value })} />
                  </div>
                </div>
              )}

              {cadence === 'monthly' && (
                <div className="row g-2 mb-3">
                  <div className="col-7">
                    <label className="form-label small fw-semibold">Day of month</label>
                    <select className="form-select form-select-sm" style={{ borderRadius: 8 }}
                      value={sched.monthly?.dayOfMonth ?? 1}
                      onChange={(e) => patchBlock('monthly', { dayOfMonth: Number(e.target.value) })}>
                      {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}</option>)}
                    </select>
                  </div>
                  <div className="col-5">
                    <label className="form-label small fw-semibold">Time</label>
                    <input type="time" className="form-control form-control-sm" style={{ borderRadius: 8 }}
                      value={sched.monthly?.time || '00:00'}
                      onChange={(e) => patchBlock('monthly', { time: e.target.value })} />
                  </div>
                </div>
              )}

              <div className="rounded-2 p-2 mb-3" style={{ background: '#eef2ff', border: '1px solid #c7d2fe' }}>
                <span className="small" style={{ fontSize: '0.76rem' }}>
                  <i className="bi bi-arrow-repeat me-1 text-primary" />{formatAgendaResetHint(sched)}.
                </span>
              </div>
            </>
          )}

          <div className="d-flex gap-2 justify-content-end">
            <button className="btn btn-sm btn-outline-secondary px-3" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="btn btn-sm btn-dark px-3 d-inline-flex align-items-center gap-1" onClick={handleSave} disabled={saving || loading}>
              {saving ? <><span className="spinner-border spinner-border-sm" /> Saving…</> : <><i className="bi bi-check-lg" /> Save</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
