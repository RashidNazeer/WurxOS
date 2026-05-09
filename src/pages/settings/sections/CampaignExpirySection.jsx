import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../../contexts/AuthContext';
import { updateUserProfile } from '../../../lib/adminApi';
import { BellIcon, AlertIcon, CheckIcon } from '../../../components/common/Icon';
import SectionShell from './SectionShell';
import PktChip from './PktChip';

// Shared settings section for both "Campaigns" and "Product Campaigns"
// expiry reminders. Differs only by the `kind` key that targets a
// sub-object on profiles.notification_prefs. The DB cron job reads
// the same shape — see migration 077.
//
// Preference shape (stored on profiles.notification_prefs.{kind}):
//   { push: true, lead_days: [3, 1] }
//
//   push        — master on/off. When false, NO expiry notifications.
//   lead_days   — the days-before-end when we fire. Empty = silent.
//                 Defaults to [3, 1] on the server side when null.

const LEAD_OPTIONS = [
  { value: 14, label: '14 days before' },
  { value:  7, label: '1 week before'  },
  { value:  5, label: '5 days before'  },
  { value:  3, label: '3 days before'  },
  { value:  2, label: '2 days before'  },
  { value:  1, label: '1 day before'   },
  { value:  0, label: 'On the day'     },
];

const DEFAULT_LEAD_DAYS = [3, 1];
const DEFAULT_NOTIFY_HOUR = 9;

// "0".."23" → "12:00 AM".."11:00 PM" — the cron honors whole hours.
const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => {
  const period = h < 12 ? 'AM' : 'PM';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return { value: h, label: `${hh}:00 ${period}` };
});

export default function CampaignExpirySection({ section }) {
  const { user, profile, refreshProfile } = useAuth();
  const kind = section?.kind || 'campaigns';

  const remote = profile?.notification_prefs?.[kind] || { push: true, lead_days: DEFAULT_LEAD_DAYS };
  const [pushOn, setPushOn] = useState(remote.push !== false);
  const [days, setDays]     = useState(Array.isArray(remote.lead_days) ? remote.lead_days : DEFAULT_LEAD_DAYS);
  // Delivery hour is shared across all daily-fired notifications,
  // so it lives at the top level of profiles (not nested in
  // notification_prefs[kind]). Whichever Campaigns/Product
  // Campaigns section the user edits, they're editing one preference.
  const [hour, setHour]     = useState(profile?.notify_at_hour ?? DEFAULT_NOTIFY_HOUR);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk]   = useState('');

  useEffect(() => {
    // Re-sync local state when the profile (or selected section) changes.
    const r = profile?.notification_prefs?.[kind] || { push: true, lead_days: DEFAULT_LEAD_DAYS };
    setPushOn(r.push !== false);
    setDays(Array.isArray(r.lead_days) ? r.lead_days : DEFAULT_LEAD_DAYS);
    setHour(profile?.notify_at_hour ?? DEFAULT_NOTIFY_HOUR);
  }, [profile?.notification_prefs, profile?.notify_at_hour, kind]);

  // Best-effort detection of the user's local timezone for the hint
  // beside the hour picker. Falls back to the profile.timezone if
  // the browser doesn't expose Intl.
  const browserTZ = useMemo(() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone; }
    catch { return profile?.timezone || 'UTC'; }
  }, [profile?.timezone]);

  const sortedDays = useMemo(() => [...days].sort((a, b) => b - a), [days]);

  function toggleDay(v) {
    setDays((cur) => cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]);
  }

  async function save() {
    setErr(''); setOk(''); setSaving(true);
    try {
      const prev = profile?.notification_prefs || {};
      const next = {
        ...prev,
        [kind]: { push: pushOn, lead_days: sortedDays },
      };
      await updateUserProfile(user.id, {
        notification_prefs: next,
        notify_at_hour: hour,
      });
      await refreshProfile();
      setOk('Preferences saved.');
      setTimeout(() => setOk(''), 2500);
    } catch (e) { setErr(e.message || 'Failed to save.'); }
    finally { setSaving(false); }
  }

  const dirty = (() => {
    const prev = profile?.notification_prefs?.[kind] || { push: true, lead_days: DEFAULT_LEAD_DAYS };
    if ((prev.push !== false) !== pushOn) return true;
    const prevHour = profile?.notify_at_hour ?? DEFAULT_NOTIFY_HOUR;
    if (prevHour !== hour) return true;
    const prevDays = Array.isArray(prev.lead_days) ? [...prev.lead_days].sort((a, b) => b - a) : [...DEFAULT_LEAD_DAYS].sort((a, b) => b - a);
    if (prevDays.length !== sortedDays.length) return true;
    return prevDays.some((v, i) => v !== sortedDays[i]);
  })();

  const title = kind === 'product_campaigns' ? 'Product Campaigns' : 'Campaigns';
  const subtitle = kind === 'product_campaigns'
    ? 'Reminders for product-level promotion expiries (individual promos, cart-level offers, coupons).'
    : 'Reminders for brand-level shop-wide campaign expiries.';

  return (
    <SectionShell icon={BellIcon} title={title} subtitle={subtitle}>
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
        onClick={() => !saving && setPushOn((v) => !v)}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 14px', marginBottom: 14,
          border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)',
          background: pushOn ? 'var(--accent-soft)' : 'var(--surface-1)',
          cursor: saving ? 'not-allowed' : 'pointer',
        }}
      >
        <div>
          <div style={{ fontWeight: 600, fontSize: 13.5 }}>Enable expiry reminders</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Master switch. When off, you won't receive any expiry alerts for this type.
          </div>
        </div>
        <span style={{
          width: 36, height: 20, borderRadius: 999,
          background: pushOn ? 'var(--accent)' : 'var(--surface-3)',
          border: '1px solid', borderColor: pushOn ? 'var(--accent)' : 'var(--border-default)',
          position: 'relative', flex: '0 0 auto', transition: 'background var(--dur-fast)',
        }}>
          <span style={{
            position: 'absolute',
            top: '50%', transform: 'translateY(-50%)',
            left: pushOn ? 17 : 1,
            width: 16, height: 16, borderRadius: '50%', background: '#fff',
            boxShadow: '0 1px 2px rgba(0,0,0,0.3)', transition: 'left var(--dur-fast)',
          }} />
        </span>
      </div>

      {/* Delivery hour (shared across all daily-fired notifications).
          The cron now runs hourly and only fires for users whose
          local hour matches their preference. */}
      <div style={{ opacity: pushOn ? 1 : 0.45, pointerEvents: pushOn ? 'auto' : 'none', marginBottom: 18 }}>
        <PktChip />
        <div className="settings-row-label-title" style={{ marginBottom: 2 }}>Delivery time</div>
        <div className="settings-row-label-sub" style={{ marginBottom: 10 }}>
          When to deliver these notifications, in <strong>Pakistan time (PKT)</strong>.
          Applies to all daily-fired campaign and product-campaign reminders.
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <select
            className="wx-input"
            value={hour}
            onChange={(e) => setHour(Number(e.target.value))}
            style={{ maxWidth: 180 }}
          >
            {HOUR_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Times shown above are <strong style={{ color: 'var(--text-secondary)' }}>Asia/Karachi</strong>
          </span>
        </div>
      </div>

      <div style={{ opacity: pushOn ? 1 : 0.45, pointerEvents: pushOn ? 'auto' : 'none' }}>
        <div className="settings-row-label-title" style={{ marginBottom: 2 }}>Notify me at these lead times</div>
        <div className="settings-row-label-sub" style={{ marginBottom: 10 }}>
          We'll fire one notification per option, per campaign. Pick as many as you like.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 8 }}>
          {LEAD_OPTIONS.map((opt) => {
            const on = days.includes(opt.value);
            return (
              <label key={opt.value}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '10px 12px', borderRadius: 'var(--radius-md)',
                  border: '1px solid',
                  borderColor: on ? 'var(--accent)' : 'var(--border-subtle)',
                  background: on ? 'var(--accent-soft)' : 'var(--surface-1)',
                  cursor: 'pointer',
                }}>
                <input type="checkbox" checked={on} onChange={() => toggleDay(opt.value)} />
                <span style={{ fontSize: 13, fontWeight: 500 }}>{opt.label}</span>
              </label>
            );
          })}
        </div>

        {days.length === 0 && (
          <div style={{ marginTop: 10, padding: '8px 12px', background: 'var(--surface-2)', borderRadius: 8, fontSize: 12, color: 'var(--text-muted)' }}>
            With no lead times selected, expiry reminders won't fire even though the master switch is on.
          </div>
        )}
      </div>

      <div className="settings-footer-actions">
        <button className="wx-btn wx-btn-primary" onClick={save} disabled={!dirty || saving}>
          {saving ? <><span className="wx-spinner" /> Saving…</> : 'Save preferences'}
        </button>
      </div>
    </SectionShell>
  );
}
