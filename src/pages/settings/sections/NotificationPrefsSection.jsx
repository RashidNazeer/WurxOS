import { useEffect, useState } from 'react';
import { useAuth } from '../../../contexts/AuthContext';
import { updateUserProfile } from '../../../lib/adminApi';
import { BellIcon, AlertIcon, CheckIcon } from '../../../components/common/Icon';
import SectionShell from './SectionShell';

const CATEGORIES = [
  { key: 'task',        label: 'Tasks',       blurb: 'Assignments, reassignments, status changes, comments.' },
  { key: 'report',      label: 'Reports',     blurb: 'Submissions, verifications, approvals, rejections.' },
  { key: 'brand',       label: 'Brands',      blurb: 'Brand switch requests, approvals/rejections.' },
  { key: 'leave',       label: 'Leave',       blurb: 'New requests you need to decide on, and decisions on yours.' },
  { key: 'paid_collab', label: 'Paid Collab', blurb: 'Creator and video activity updates.' },
  { key: 'system',      label: 'System',      blurb: 'Maintenance and account alerts.' },
];

const DEFAULT_ALL_ON = Object.fromEntries(CATEGORIES.map((c) => [c.key, { push: true }]));

export default function NotificationPrefsSection() {
  const { user, profile, refreshProfile } = useAuth();
  const [prefs, setPrefs] = useState(profile?.notification_prefs || DEFAULT_ALL_ON);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk]   = useState('');

  useEffect(() => {
    setPrefs(profile?.notification_prefs || DEFAULT_ALL_ON);
  }, [profile?.notification_prefs]);

  function toggle(key) {
    setPrefs((cur) => ({
      ...cur,
      [key]: { ...(cur[key] || { push: true }), push: !(cur[key]?.push ?? true) },
    }));
  }

  async function save() {
    setErr(''); setOk(''); setSaving(true);
    try {
      await updateUserProfile(user.id, { notification_prefs: prefs });
      await refreshProfile();
      setOk('Preferences saved.');
      setTimeout(() => setOk(''), 2500);
    } catch (e) { setErr(e.message || 'Failed to save.'); }
    finally { setSaving(false); }
  }

  const dirty = JSON.stringify(prefs) !== JSON.stringify(profile?.notification_prefs || DEFAULT_ALL_ON);

  return (
    <SectionShell
      icon={BellIcon}
      title="Notification preferences"
      subtitle="In-app notifications are always on. Choose which categories also send a system popup (web push)."
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

      <div style={{
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
      }}>
        {CATEGORIES.map((c, i) => {
          const on = prefs?.[c.key]?.push ?? true;
          return (
            <div
              key={c.key}
              onClick={() => !saving && toggle(c.key)}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '12px 14px',
                borderTop: i === 0 ? 'none' : '1px solid var(--border-subtle)',
                cursor: saving ? 'not-allowed' : 'pointer',
                background: on ? 'var(--accent-soft)' : 'var(--surface-1)',
              }}
            >
              <div style={{ marginRight: 12 }}>
                <div style={{ fontWeight: 600, fontSize: 13.5 }}>{c.label}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{c.blurb}</div>
              </div>
              <span
                style={{
                  width: 36, height: 20, borderRadius: 999,
                  background: on ? 'var(--accent)' : 'var(--surface-3)',
                  border: '1px solid',
                  borderColor: on ? 'var(--accent)' : 'var(--border-default)',
                  position: 'relative', flex: '0 0 auto',
                  transition: 'background var(--dur-fast)',
                }}
              >
                <span style={{
                  position: 'absolute', top: 1, left: on ? 17 : 1,
                  width: 16, height: 16, borderRadius: '50%',
                  background: '#fff',
                  boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
                  transition: 'left var(--dur-fast)',
                }} />
              </span>
            </div>
          );
        })}
      </div>

      <div className="settings-footer-actions">
        <button className="wx-btn wx-btn-primary" onClick={save} disabled={!dirty || saving}>
          {saving ? <><span className="wx-spinner" /> Saving…</> : 'Save preferences'}
        </button>
      </div>
    </SectionShell>
  );
}
