import { useEffect, useState } from 'react';
import { useAuth } from '../../../contexts/AuthContext';
import { updateUserProfile } from '../../../lib/adminApi';
import { StarIcon, AlertIcon, CheckIcon } from '../../../components/common/Icon';
import SectionShell from './SectionShell';

// Stored on profiles.notification_prefs.tier.enabled (mig 078 / 287). The tier
// reminder is now per-brand and date-driven (mig 287): record a brand's last
// sale date on its detail page and it reminds 3/2/1 days before (date + 30d),
// then daily until you update the date or set the tier to unlimited. This toggle
// is just the master on/off — the per-slot day/time pickers are retired.
const DEFAULT_ENABLED = true;

const SCOPE_COPY = {
  boss:      'every active brand that isn\'t unlimited and has a last-sale date set.',
  ol:        'every active brand that isn\'t unlimited and has a last-sale date set.',
  developer: 'every active brand that isn\'t unlimited and has a last-sale date set (Boss parity for debugging).',
  tl:        'YOUR brands (ones you own) that aren\'t unlimited and have a last-sale date set.',
  pctl:      'YOUR brands (ones you own) that aren\'t unlimited and have a last-sale date set.',
  apc:       'brands assigned to you that aren\'t unlimited and have a last-sale date set.',
  ipc:       'brands assigned to you that aren\'t unlimited and have a last-sale date set.',
};

export default function TierNotificationsSection() {
  const { user, profile, refreshProfile } = useAuth();
  const role = profile?.role;
  const remote = profile?.notification_prefs?.tier?.enabled ?? DEFAULT_ENABLED;

  const [enabled, setEnabled] = useState(remote);
  const [saving, setSaving]   = useState(false);
  const [err, setErr]         = useState('');
  const [ok, setOk]           = useState('');

  useEffect(() => {
    setEnabled(profile?.notification_prefs?.tier?.enabled ?? DEFAULT_ENABLED);
  }, [profile?.notification_prefs?.tier?.enabled]);

  const dirty = enabled !== (profile?.notification_prefs?.tier?.enabled ?? DEFAULT_ENABLED);

  async function save() {
    setErr(''); setOk(''); setSaving(true);
    try {
      const prev = profile?.notification_prefs || {};
      // Preserve any legacy slot fields; we only own `enabled` now.
      const next = { ...prev, tier: { ...(prev.tier || {}), enabled } };
      await updateUserProfile(user.id, { notification_prefs: next });
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
      subtitle="Per-brand reminders to generate a sale before a brand's tier locks."
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
            You&apos;ll be reminded about {SCOPE_COPY[role] || 'brands that aren\'t unlimited and have a last-sale date set.'}
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

      <div style={{
        padding: '10px 12px',
        background: 'var(--surface-2)', borderRadius: 8, fontSize: 12.5, color: 'var(--text-secondary)',
      }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>How it works</div>
        <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
          <li>Open a brand&apos;s detail page and set <strong>Last sale generated</strong> under &ldquo;Tier sale tracker&rdquo;.</li>
          <li>You&apos;re reminded <strong>3, 2, and 1 day before</strong> that date + 30 days, then <strong>daily</strong> until you act.</li>
          <li>Reminders <strong>stop</strong> when you update the date (a new sale) or set the tier to <strong>unlimited</strong>.</li>
          <li>Each brand gets its own notification, delivered around <strong>9:00 AM (PKT)</strong>.</li>
          <li>Brands with tier <strong>unlimited</strong> (or no tier) are never included.</li>
        </ul>
      </div>

      <div className="settings-footer-actions">
        <button className="wx-btn wx-btn-primary" onClick={save} disabled={!dirty || saving}>
          {saving ? <><span className="wx-spinner" /> Saving…</> : 'Save preferences'}
        </button>
      </div>
    </SectionShell>
  );
}
