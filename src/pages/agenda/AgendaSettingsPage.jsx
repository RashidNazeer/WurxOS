import React, { useEffect, useState } from 'react';
import { getAgendaSettings, updateAgendaSettings } from '../../lib/agendaApi';

// Weekly Agenda Meetings — settings (OL / Boss only).
// Phase 1: permanent Google Meet link + meeting day.

const DAYS = [
  ['monday', 'Monday'], ['tuesday', 'Tuesday'], ['wednesday', 'Wednesday'],
  ['thursday', 'Thursday'], ['friday', 'Friday'], ['saturday', 'Saturday'],
  ['sunday', 'Sunday'],
];

export default function AgendaSettingsPage() {
  const [loading, setLoading]     = useState(true);
  const [saving, setSaving]       = useState(false);
  const [meetLink, setMeetLink]   = useState('');
  const [meetingDay, setMeetingDay] = useState('tuesday');
  const [error, setError]         = useState('');
  const [savedTick, setSavedTick] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getAgendaSettings()
      .then((s) => {
        if (cancelled) return;
        setMeetLink(s.google_meet_link || '');
        setMeetingDay(s.meeting_day || 'tuesday');
      })
      .catch((e) => { if (!cancelled) setError(e.message || 'Failed to load settings.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  async function handleSave() {
    setSaving(true);
    setError('');
    try {
      await updateAgendaSettings({ googleMeetLink: meetLink, meetingDay });
      setSavedTick(true);
      setTimeout(() => setSavedTick(false), 2500);
    } catch (e) {
      setError(e.message || 'Failed to save.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div style={{ padding: '32px' }}>
        <div className="d-flex align-items-center gap-2 text-muted">
          <span className="spinner-border spinner-border-sm" /> Loading settings…
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: '32px 32px 48px', maxWidth: 720 }}>
      <div className="mb-4">
        <h5 className="fw-bold mb-1 d-flex align-items-center gap-2" style={{ color: '#1a1a2e' }}>
          <i className="bi bi-calendar-week" style={{ fontSize: '1.15rem' }} />
          Agenda Meeting Settings
        </h5>
        <p className="text-muted small mb-0">Configure the weekly agenda meeting. Only Operation Leads manage this.</p>
      </div>

      {error && <div className="alert alert-danger py-2 small">{error}</div>}

      <div className="card border-0 shadow-sm" style={{ borderRadius: 14 }}>
        <div className="card-body p-4">
          <div className="mb-4">
            <label className="form-label small fw-semibold d-flex align-items-center gap-2">
              <i className="bi bi-camera-video text-primary" />
              Permanent Google Meet Link
            </label>
            <input
              type="url"
              className="form-control"
              placeholder="https://meet.google.com/abc-defg-hij"
              value={meetLink}
              onChange={(e) => setMeetLink(e.target.value)}
              style={{ borderRadius: 8 }}
            />
            <div className="text-muted mt-1" style={{ fontSize: '0.74rem' }}>
              The reusable meeting link shared with the whole office each week.
            </div>
          </div>

          <div className="mb-4">
            <label className="form-label small fw-semibold d-flex align-items-center gap-2">
              <i className="bi bi-calendar-event text-primary" />
              Meeting Day
            </label>
            <select
              className="form-select"
              value={meetingDay}
              onChange={(e) => setMeetingDay(e.target.value)}
              style={{ borderRadius: 8, maxWidth: 240 }}
            >
              {DAYS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <div className="text-muted mt-1" style={{ fontSize: '0.74rem' }}>
              The day the weekly agenda meeting is held (default Tuesday).
            </div>
          </div>

          <div className="d-flex align-items-center gap-2">
            <button
              className="btn btn-sm btn-dark px-3 d-inline-flex align-items-center gap-1"
              style={{ borderRadius: 8 }}
              onClick={handleSave}
              disabled={saving}
            >
              {saving
                ? <><span className="spinner-border spinner-border-sm" /> Saving…</>
                : <><i className="bi bi-check-lg" /> Save settings</>}
            </button>
            {savedTick && (
              <span className="text-success small d-inline-flex align-items-center gap-1">
                <i className="bi bi-check-circle-fill" /> Saved
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="text-muted mt-3" style={{ fontSize: '0.74rem' }}>
        <i className="bi bi-info-circle me-1" />
        More agenda configuration (ratings, meeting records) arrives in the next phase.
      </div>
    </div>
  );
}
