import { useEffect, useState } from 'react';
import { useAuth } from '../../../contexts/AuthContext';
import { updateUserProfile } from '../../../lib/adminApi';
import { supabase } from '../../../lib/supabase';
import { StarIcon, AlertIcon, CheckIcon } from '../../../components/common/Icon';
import SectionShell from './SectionShell';
import PktChip from './PktChip';

// Stored on profiles.notification_prefs.tier (see migration 078).
const DEFAULTS = {
  enabled: true,
  day1: 25, time1: '09:00',
  day2: 30, time2: '18:00',
};

// The DB cron function scopes the brand list by the caller's role —
// this copy just explains what they'll receive so they know what the
// toggle is actually doing.
const SCOPE_COPY = {
  boss:      'You\'ll be reminded about every active brand with a concrete tier.',
  ol:        'You\'ll be reminded about every active brand with a concrete tier.',
  developer: 'Dev account — you\'ll see every active brand with a concrete tier (Boss parity for debugging).',
  tl:        'You\'ll be reminded about YOUR brands (ones you own) that have a concrete tier.',
  pctl:      'You\'ll be reminded about YOUR brands (ones you own) that have a concrete tier.',
  apc:       'You\'ll be reminded about brands assigned to you that have a concrete tier.',
  ipc:       'You\'ll be reminded about brands assigned to you that have a concrete tier.',
};

function clampDay(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.min(Math.max(Math.round(n), 1), 31);
}

export default function TierNotificationsSection() {
  const { user, profile, refreshProfile } = useAuth();
  const role = profile?.role;
  const remote = { ...DEFAULTS, ...(profile?.notification_prefs?.tier || {}) };

  const [enabled, setEnabled] = useState(remote.enabled);
  const [day1, setDay1]       = useState(remote.day1);
  const [time1, setTime1]     = useState(remote.time1);
  const [day2, setDay2]       = useState(remote.day2);
  const [time2, setTime2]     = useState(remote.time2);
  const [saving, setSaving]   = useState(false);
  const [err, setErr]         = useState('');
  const [ok, setOk]           = useState('');

  useEffect(() => {
    const r = { ...DEFAULTS, ...(profile?.notification_prefs?.tier || {}) };
    setEnabled(r.enabled);
    setDay1(r.day1); setTime1(r.time1);
    setDay2(r.day2); setTime2(r.time2);
  }, [profile?.notification_prefs?.tier]);

  const dirty = (() => {
    const r = { ...DEFAULTS, ...(profile?.notification_prefs?.tier || {}) };
    return enabled !== r.enabled
      || clampDay(day1) !== r.day1 || time1 !== r.time1
      || clampDay(day2) !== r.day2 || time2 !== r.time2;
  })();

  async function save() {
    setErr(''); setOk(''); setSaving(true);
    try {
      const prev = profile?.notification_prefs || {};
      const prevTier = prev.tier || {};
      const newTier = {
        enabled,
        day1: clampDay(day1), time1,
        day2: clampDay(day2), time2,
      };
      const next = { ...prev, tier: newTier };
      await updateUserProfile(user.id, { notification_prefs: next });

      // If the user changed slot 1's day/time or slot 2's day/time, clear
      // that slot's "already fired" log entry for the current month so the
      // new schedule actually gets a chance to fire. Without this the cron
      // sees the existing log row and skips.
      const slot1Changed = prevTier.day1 !== newTier.day1 || prevTier.time1 !== newTier.time1;
      const slot2Changed = prevTier.day2 !== newTier.day2 || prevTier.time2 !== newTier.time2;
      if (slot1Changed || slot2Changed) {
        // Compute current month in PKT (the cron's timezone), so the rearm
        // matches what the cron will check on its next tick.
        const pkt = new Intl.DateTimeFormat('en-US', {
          timeZone: 'Asia/Karachi', year: 'numeric', month: 'numeric',
        }).formatToParts(new Date()).reduce((m, p) => { m[p.type] = p.value; return m; }, {});
        const slotsToClear = [
          ...(slot1Changed ? [1] : []),
          ...(slot2Changed ? [2] : []),
        ];
        await supabase.from('tier_notification_log')
          .delete()
          .eq('user_id', user.id)
          .eq('year', Number(pkt.year))
          .eq('month', Number(pkt.month))
          .in('slot_idx', slotsToClear);
      }

      await refreshProfile();
      setOk('Preferences saved.');
      setTimeout(() => setOk(''), 2500);
    } catch (e) { setErr(e.message || 'Failed to save.'); }
    finally { setSaving(false); }
  }

  return (
    <SectionShell
      icon={StarIcon}
      title="Tier notifications"
      subtitle="Monthly reminders for brands that need sale generation to hit their tier target."
    >
      {err && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 10 }}>
          <AlertIcon width="14" height="14" /> <span>{err}</span>
        </div>
      )}
      {ok && (
        <div className="wx-alert wx-alert-success" style={{ marginBottom: 10 }}>
          <CheckIcon width="14" height="14" /> <span>{ok}</span>
        </div>
      )}

      {/* Master toggle */}
      <div
        onClick={() => !saving && setEnabled((v) => !v)}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 14px', marginBottom: 14,
          border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)',
          background: enabled ? 'var(--accent-soft)' : 'var(--surface-1)',
          cursor: saving ? 'not-allowed' : 'pointer',
        }}
      >
        <div>
          <div style={{ fontWeight: 600, fontSize: 13.5 }}>Enable tier notifications</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {SCOPE_COPY[role] || 'You\'ll be reminded about brands that have a concrete tier.'}
          </div>
        </div>
        <span style={{
          width: 36, height: 20, borderRadius: 999,
          background: enabled ? 'var(--accent)' : 'var(--surface-3)',
          border: '1px solid', borderColor: enabled ? 'var(--accent)' : 'var(--border-default)',
          position: 'relative', flex: '0 0 auto', transition: 'background var(--dur-fast)',
        }}>
          <span style={{
            position: 'absolute', top: 1, left: enabled ? 17 : 1,
            width: 16, height: 16, borderRadius: '50%', background: '#fff',
            boxShadow: '0 1px 2px rgba(0,0,0,0.3)', transition: 'left var(--dur-fast)',
          }} />
        </span>
      </div>

      <div style={{ opacity: enabled ? 1 : 0.45, pointerEvents: enabled ? 'auto' : 'none' }}>
        <PktChip />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
          <SlotCard
            tone="#f59e0b"
            title="First reminder"
            hint="Early warning so teams still have runway — suggest day 25."
            day={day1} time={time1} saving={saving}
            onDay={setDay1} onTime={setTime1}
          />
          <SlotCard
            tone="#ef4444"
            title="Final reminder"
            hint="Last-call nudge near month-end — suggest day 30."
            day={day2} time={time2} saving={saving}
            onDay={setDay2} onTime={setTime2}
          />
        </div>

        <div style={{
          marginTop: 14, padding: '10px 12px',
          background: 'var(--surface-2)', borderRadius: 8, fontSize: 12.5, color: 'var(--text-secondary)',
        }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>How it works</div>
          <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
            <li>Cron checks every 5 minutes; your slot fires once it's due.</li>
            <li>All times are in <strong>Pakistan time (PKT)</strong>, regardless of your laptop's clock.</li>
            <li>At most one notification per slot per month — no repeats.</li>
            <li>If you pick day 29–31 and the month is shorter, it auto-uses the last day.</li>
            <li>Brands with tier <strong>unlimited</strong> (or no tier at all) are excluded.</li>
          </ul>
        </div>
      </div>

      <div className="settings-footer-actions">
        <button className="wx-btn wx-btn-primary" onClick={save} disabled={!dirty || saving}>
          {saving ? <><span className="wx-spinner" /> Saving…</> : 'Save preferences'}
        </button>
      </div>
    </SectionShell>
  );
}

function SlotCard({ tone, title, hint, day, time, saving, onDay, onTime }) {
  return (
    <div style={{
      padding: 12,
      border: '1px solid var(--border-subtle)',
      borderLeft: `3px solid ${tone}`,
      borderRadius: 'var(--radius-md)',
      background: 'var(--surface-1)',
    }}>
      <div style={{ fontWeight: 600, fontSize: 13.5, color: tone, marginBottom: 2 }}>{title}</div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>{hint}</div>
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: '0 0 90px' }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 4 }}>Day</div>
          <input
            type="number" min={1} max={31}
            className="wx-input"
            value={day} disabled={saving}
            onChange={(e) => onDay(e.target.value)}
          />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 4 }}>
            Time <span style={{ color: 'var(--accent)', fontWeight: 700 }}>(PKT)</span>
          </div>
          <input
            type="time"
            className="wx-input"
            value={time} disabled={saving}
            onChange={(e) => onTime(e.target.value)}
          />
        </div>
      </div>
    </div>
  );
}

