import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../../contexts/AuthContext';
import {
  DEFAULT_RESET_SCHEDULE, detectBrowserTimezone,
  getUserResetSchedule, updateResetSchedule,
} from '../../../lib/tasksApi';
import { setMyShiftStart } from '../../../lib/attendanceApi';
import { ClockIcon, AlertIcon, CheckIcon } from '../../../components/common/Icon';
import SectionShell from './SectionShell';
import PktChip from './PktChip';

const DAYS = [
  { v: 0, label: 'Sun' }, { v: 1, label: 'Mon' }, { v: 2, label: 'Tue' },
  { v: 3, label: 'Wed' }, { v: 4, label: 'Thu' }, { v: 5, label: 'Fri' }, { v: 6, label: 'Sat' },
];

export default function TimeShiftSection() {
  const { user, refreshProfile } = useAuth();
  const [schedule, setSchedule] = useState(DEFAULT_RESET_SCHEDULE);
  const [timezone, setTimezone] = useState('UTC');
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState('');
  const [success, setSuccess]   = useState('');

  useEffect(() => {
    let cancelled = false;
    if (!user?.id) return;
    setLoading(true);
    getUserResetSchedule(user.id)
      .then(({ schedule: s, timezone: t }) => {
        if (cancelled) return;
        setSchedule(s);
        setTimezone(t === 'UTC' ? detectBrowserTimezone() : t);
      })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [user?.id]);

  async function save() {
    setError(''); setSuccess('');
    setSaving(true);
    try {
      await updateResetSchedule(user.id, { schedule, timezone });
      await refreshProfile();
      setSuccess('Schedule saved. Your open recurring tasks have been updated.');
      setTimeout(() => setSuccess(''), 3500);
    } catch (err) { setError(err.message || 'Failed to save.'); }
    finally { setSaving(false); }
  }

  const setDaily = (p)   => setSchedule((s) => ({ ...s, daily:   { ...s.daily,   ...p } }));
  const setWeekly = (p)  => setSchedule((s) => ({ ...s, weekly:  { ...s.weekly,  ...p } }));
  const setMonthly = (p) => setSchedule((s) => ({ ...s, monthly: { ...s.monthly, ...p } }));

  const tzOffsetHint = useMemo(() => {
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'shortOffset' }).formatToParts(new Date());
      return parts.find((p) => p.type === 'timeZoneName')?.value || '';
    } catch { return ''; }
  }, [timezone]);

  return (
    <>
      <ShiftStartSection />
      <SectionShell
        icon={ClockIcon}
        title="Recurring task reset schedule"
        subtitle="When your daily / weekly / monthly tasks re-open after you mark them done. All times are Pakistan time (PKT)."
      >
      {error && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 14 }}>
          <AlertIcon width="16" height="16" /> <span>{error}</span>
        </div>
      )}
      {success && (
        <div className="wx-alert wx-alert-success" style={{ marginBottom: 14 }}>
          <CheckIcon width="16" height="16" /> <span>{success}</span>
        </div>
      )}

      {loading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>
          <span className="wx-spinner" style={{ color: 'var(--accent)' }} /> Loading…
        </div>
      ) : (
        <>
          <PktChip />
          <div style={{
            padding: '10px 14px', marginBottom: 14,
            background: 'var(--surface-2)',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border-subtle)',
            fontSize: 12.5, color: 'var(--text-secondary)',
          }}>
            All times below are interpreted as <strong style={{ color: 'var(--text-primary)' }}>Pakistan time (Asia/Karachi)</strong> —
            even if your laptop's clock is set to another zone.
          </div>

          <div className="settings-row">
            <div>
              <div className="settings-row-label-title">Daily</div>
              <div className="settings-row-label-sub">Every day at…</div>
            </div>
            <input
              type="time"
              className="wx-input"
              style={{ maxWidth: 140 }}
              value={schedule.daily.time}
              onChange={(e) => setDaily({ time: e.target.value })}
              disabled={saving}
            />
          </div>

          <div className="settings-row">
            <div>
              <div className="settings-row-label-title">Weekly</div>
              <div className="settings-row-label-sub">Pick a day and time</div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <select
                className="wx-input"
                style={{ maxWidth: 100 }}
                value={schedule.weekly.dayOfWeek}
                onChange={(e) => setWeekly({ dayOfWeek: Number(e.target.value) })}
                disabled={saving}
              >
                {DAYS.map((d) => <option key={d.v} value={d.v}>{d.label}</option>)}
              </select>
              <input
                type="time"
                className="wx-input"
                style={{ maxWidth: 140 }}
                value={schedule.weekly.time}
                onChange={(e) => setWeekly({ time: e.target.value })}
                disabled={saving}
              />
            </div>
          </div>

          <div className="settings-row">
            <div>
              <div className="settings-row-label-title">Monthly</div>
              <div className="settings-row-label-sub">Pick a day of month and time</div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="number"
                min={1} max={28}
                className="wx-input"
                style={{ maxWidth: 80 }}
                value={schedule.monthly.dayOfMonth}
                onChange={(e) => setMonthly({ dayOfMonth: Number(e.target.value || 1) })}
                disabled={saving}
              />
              <input
                type="time"
                className="wx-input"
                style={{ maxWidth: 140 }}
                value={schedule.monthly.time}
                onChange={(e) => setMonthly({ time: e.target.value })}
                disabled={saving}
              />
            </div>
          </div>

          <div className="settings-footer-actions">
            <button className="wx-btn wx-btn-primary" onClick={save} disabled={saving}>
              {saving ? <><span className="wx-spinner" /> Saving…</> : 'Save changes'}
            </button>
          </div>
        </>
      )}
      </SectionShell>
    </>
  );
}

// ── Your shift start — powers the "forgot to clock in" reminder (mig 254) ──
// A wall-clock time the user enters as Pakistan time. We never touch the
// browser's timezone: what they type is stored and compared as PKT, so a
// laptop set to another zone can't shift it. Empty = reminder off.
function ShiftStartSection() {
  const { profile, refreshProfile } = useAuth();
  // profiles.shift_start_time comes back as 'HH:MM:SS'; the <input type=time> wants 'HH:MM'.
  const initial = (profile?.shift_start_time || '').slice(0, 5);
  const [time, setTime]     = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => { setTime((profile?.shift_start_time || '').slice(0, 5)); }, [profile?.shift_start_time]);

  const dirty = time !== initial;

  async function save() {
    setError(''); setSuccess(''); setSaving(true);
    try {
      await setMyShiftStart(time || null);
      await refreshProfile();
      setSuccess(time ? 'Shift start saved. We’ll remind you if you haven’t clocked in an hour after this time.'
                      : 'Shift start cleared. You won’t get clock-in reminders.');
      setTimeout(() => setSuccess(''), 4000);
    } catch (err) { setError(err.message || 'Failed to save.'); }
    finally { setSaving(false); }
  }

  return (
    <SectionShell
      icon={ClockIcon}
      title="Your shift start"
      subtitle="When your work shift begins. If you haven’t clocked in an hour after this time, we’ll pop up a friendly reminder."
    >
      {error && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 14 }}>
          <AlertIcon width="16" height="16" /> <span>{error}</span>
        </div>
      )}
      {success && (
        <div className="wx-alert wx-alert-success" style={{ marginBottom: 14 }}>
          <CheckIcon width="16" height="16" /> <span>{success}</span>
        </div>
      )}

      <div style={{
        padding: '10px 14px', marginBottom: 14,
        background: 'var(--surface-2)', borderRadius: 'var(--radius-md)',
        border: '1px solid var(--border-subtle)', fontSize: 12.5, color: 'var(--text-secondary)',
      }}>
        Enter this in <strong style={{ color: 'var(--text-primary)' }}>Pakistan time (PKT)</strong> no matter
        where you are or what your laptop clock says. Leave it empty to turn the reminder off.
      </div>

      <div className="settings-row">
        <div>
          <div className="settings-row-label-title">Shift start time</div>
          <div className="settings-row-label-sub">Pakistan time (Asia/Karachi)</div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="time"
            className="wx-input"
            style={{ maxWidth: 140 }}
            value={time}
            onChange={(e) => setTime(e.target.value)}
            disabled={saving}
          />
          {time && (
            <button type="button" className="wx-btn wx-btn-ghost" onClick={() => setTime('')} disabled={saving}
              style={{ fontSize: 12.5 }}>
              Clear
            </button>
          )}
        </div>
      </div>

      <div className="settings-footer-actions">
        <button className="wx-btn wx-btn-primary" onClick={save} disabled={saving || !dirty}>
          {saving ? <><span className="wx-spinner" /> Saving…</> : 'Save shift start'}
        </button>
      </div>
    </SectionShell>
  );
}
