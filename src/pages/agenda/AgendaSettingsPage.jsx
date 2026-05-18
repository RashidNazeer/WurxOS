import React, { useEffect, useState } from 'react';
import { getAgendaSettings, updateAgendaSettings } from '../../lib/agendaApi';
import AgendaSchedulesTab from '../../components/agenda/AgendaSchedulesTab';

// Weekly Agenda Meetings — settings (OL / Boss only).
// Tabbed: General (Meet link + default day) · Schedules (per-team slot).

const TABS = [
  { key: 'general',   label: 'General',   icon: 'bi-sliders' },
  { key: 'schedules', label: 'Schedules', icon: 'bi-calendar2-week' },
];

export default function AgendaSettingsPage() {
  const [tab, setTab] = useState('general');

  return (
    <div style={{ padding: '32px 32px 48px', maxWidth: 760 }}>
      <div className="mb-4">
        <h5 className="fw-bold mb-1 d-flex align-items-center gap-2" style={{ color: '#1a1a2e' }}>
          <i className="bi bi-calendar-week" style={{ fontSize: '1.15rem' }} />
          Agenda Meeting Settings
        </h5>
        <p className="text-muted small mb-0">Configure the weekly agenda meeting. Only Operation Leads manage this.</p>
      </div>

      <div className="d-flex gap-1 p-1 rounded-3 mb-4" style={{ background: '#f0f1f5', width: 'fit-content' }}>
        {TABS.map((t) => (
          <button key={t.key} type="button"
            className="btn btn-sm d-inline-flex align-items-center gap-1"
            style={{
              background: tab === t.key ? '#1a1a2e' : 'transparent',
              color: tab === t.key ? '#fff' : '#64748b',
              border: 'none', borderRadius: 8, padding: '6px 14px',
              fontSize: '0.78rem', fontWeight: 700,
            }}
            onClick={() => setTab(t.key)}>
            <i className={`bi ${t.icon}`} />{t.label}
          </button>
        ))}
      </div>

      {tab === 'general'   && <GeneralTab />}
      {tab === 'schedules' && <AgendaSchedulesTab />}
    </div>
  );
}

// ── General ─────────────────────────────────────────────────────────────
function GeneralTab() {
  const [loading, setLoading]     = useState(true);
  const [saving, setSaving]       = useState(false);
  const [meetLink, setMeetLink]   = useState('');
  const [error, setError]         = useState('');
  const [savedTick, setSavedTick] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getAgendaSettings()
      .then((s) => {
        if (cancelled) return;
        setMeetLink(s.google_meet_link || '');
      })
      .catch((e) => { if (!cancelled) setError(e.message || 'Failed to load settings.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  async function handleSave() {
    setSaving(true);
    setError('');
    try {
      await updateAgendaSettings({ googleMeetLink: meetLink });
      setSavedTick(true);
      setTimeout(() => setSavedTick(false), 2500);
    } catch (e) {
      setError(e.message || 'Failed to save.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="text-muted small py-3"><span className="spinner-border spinner-border-sm me-2" />Loading…</div>;
  }

  return (
    <>
      {error && <div className="alert alert-danger py-2 small">{error}</div>}
      <div className="card border-0 shadow-sm" style={{ borderRadius: 14 }}>
        <div className="card-body p-4">
          <div className="mb-4">
            <label className="form-label small fw-semibold d-flex align-items-center gap-2">
              <i className="bi bi-camera-video text-primary" />
              Permanent Google Meet Link
            </label>
            <input type="url" className="form-control" style={{ borderRadius: 8 }}
              placeholder="https://meet.google.com/abc-defg-hij"
              value={meetLink} onChange={(e) => setMeetLink(e.target.value)} />
            <div className="text-muted mt-1" style={{ fontSize: '0.74rem' }}>
              The reusable meeting link shared with the whole office each week.
            </div>
          </div>

          <div className="text-muted mb-4" style={{ fontSize: '0.74rem' }}>
            <i className="bi bi-info-circle me-1" />
            Each team’s meeting day &amp; time is set per-team under the Schedules tab.
          </div>

          <div className="d-flex align-items-center gap-2">
            <button className="btn btn-sm btn-dark px-3 d-inline-flex align-items-center gap-1" style={{ borderRadius: 8 }}
              onClick={handleSave} disabled={saving}>
              {saving ? <><span className="spinner-border spinner-border-sm" /> Saving…</> : <><i className="bi bi-check-lg" /> Save settings</>}
            </button>
            {savedTick && (
              <span className="text-success small d-inline-flex align-items-center gap-1">
                <i className="bi bi-check-circle-fill" /> Saved
              </span>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
