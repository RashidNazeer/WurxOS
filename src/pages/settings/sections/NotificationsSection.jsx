import { useEffect, useState } from 'react';
import { useAuth } from '../../../contexts/AuthContext';
import {
  pushSupported, permissionState, getCurrentSubscription,
  enablePush, disablePush,
  listMyPushSubscriptions, removePushSubscription, describePushSubscription,
} from '../../../lib/pushApi';
import { BellIcon, AlertIcon, CheckIcon, XIcon } from '../../../components/common/Icon';
import SectionShell from './SectionShell';

export default function NotificationsSection() {
  const { user } = useAuth();
  const [supported, setSupported]   = useState(true);
  const [perm, setPerm]             = useState('default');
  const [enabled, setEnabled]       = useState(false);
  const [busy, setBusy]             = useState(false);
  const [err, setErr]               = useState('');
  const [ok, setOk]                 = useState('');
  const [devices, setDevices]             = useState([]);
  const [currentEndpoint, setCurrentEp]   = useState(null);
  const [devicesLoading, setDevicesLoading] = useState(true);

  async function refresh() {
    const s = pushSupported();
    setSupported(s);
    if (!s) { setDevicesLoading(false); return; }
    setPerm(permissionState());
    const sub = await getCurrentSubscription();
    setEnabled(!!sub);
    setCurrentEp(sub?.endpoint || null);
    try {
      const list = await listMyPushSubscriptions();
      setDevices(list);
    } catch (_) { /* shown via err by refresh callers */ }
    finally { setDevicesLoading(false); }
  }

  useEffect(() => { refresh(); }, []);

  async function removeDevice(row) {
    if (!confirm('Remove this device? It will stop receiving push notifications until it re-enables them.')) return;
    setErr(''); setOk('');
    try {
      await removePushSubscription(row.id, row.endpoint);
      setOk('Device removed.');
      await refresh();
      setTimeout(() => setOk(''), 2500);
    } catch (e) { setErr(e.message || 'Failed to remove device.'); }
  }

  async function onEnable() {
    setErr(''); setOk(''); setBusy(true);
    try {
      await enablePush(user.id);
      setOk('Push notifications enabled on this device.');
      await refresh();
      setTimeout(() => setOk(''), 3000);
    } catch (e) { setErr(e.message || 'Failed to enable push.'); }
    finally { setBusy(false); }
  }

  async function onDisable() {
    setErr(''); setOk(''); setBusy(true);
    try {
      await disablePush();
      setOk('Push disabled on this device.');
      await refresh();
      setTimeout(() => setOk(''), 3000);
    } catch (e) { setErr(e.message || 'Failed to disable push.'); }
    finally { setBusy(false); }
  }

  return (
    <SectionShell
      icon={BellIcon}
      title="Notifications"
      subtitle="System-level popups for tasks, reports and other events — even when the tab is closed."
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

      <div className="settings-row">
        <div>
          <div className="settings-row-label-title">Push notifications on this device</div>
          <div className="settings-row-label-sub">
            {!supported   && 'This browser does not support web push.'}
            {supported && perm === 'denied' && 'Notifications are blocked in your browser settings. Allow them to enable push.'}
            {supported && perm !== 'denied' && (enabled
              ? 'You will receive a system popup on this device whenever you get a notification.'
              : 'Turn on to get system popups in addition to the in-app bell.')}
          </div>
        </div>
        <div>
          {enabled ? (
            <button className="wx-btn wx-btn-ghost" onClick={onDisable} disabled={busy}>
              {busy ? <><span className="wx-spinner" /> Working…</> : 'Turn off'}
            </button>
          ) : (
            <button
              className="wx-btn wx-btn-primary"
              onClick={onEnable}
              disabled={busy || !supported || perm === 'denied'}
            >
              {busy ? <><span className="wx-spinner" /> Working…</> : 'Turn on'}
            </button>
          )}
        </div>
      </div>

      {/* Registered devices — lets the user see every browser / tab
          still subscribed to pushes for this account, and remove the
          stale ones (e.g. leftover localhost subscriptions). */}
      <div style={{ marginTop: 18 }}>
        <div className="settings-row-label-title" style={{ marginBottom: 4 }}>
          Registered devices
        </div>
        <div className="settings-row-label-sub" style={{ marginBottom: 10 }}>
          Every browser that's enabled push for your account. Remove any you
          don't recognise — the deleted device won't get pushes again until
          it re-enables them.
        </div>
        {devicesLoading ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
            <span className="wx-spinner" /> Loading…
          </div>
        ) : devices.length === 0 ? (
          <div style={{
            border: '1px dashed var(--border-default)',
            borderRadius: 'var(--radius-md)',
            padding: '14px 16px',
            color: 'var(--text-muted)',
            fontSize: 13,
          }}>
            No devices registered yet. Turn on push above to register this one.
          </div>
        ) : (
          <div style={{
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            overflow: 'hidden',
          }}>
            {devices.map((d, i) => {
              const desc = describePushSubscription(d);
              const isThis = d.endpoint === currentEndpoint;
              return (
                <div key={d.id}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr auto',
                    alignItems: 'center',
                    gap: 12,
                    padding: '12px 14px',
                    background: isThis ? 'var(--accent-soft)' : 'var(--surface-1)',
                    borderTop: i === 0 ? 'none' : '1px solid var(--border-subtle)',
                  }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      fontWeight: 700, fontSize: 13.5, color: 'var(--text-primary)',
                    }}>
                      <span>{desc.label}</span>
                      {isThis && (
                        <span style={{
                          fontSize: 10, fontWeight: 800, padding: '2px 7px',
                          borderRadius: 999, background: 'var(--accent)', color: 'var(--on-accent)',
                          textTransform: 'uppercase', letterSpacing: '0.05em',
                        }}>This device</span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                      {desc.service} · registered {new Date(d.created_at).toLocaleDateString(undefined, {
                        month: 'short', day: 'numeric', year: 'numeric',
                      })}
                    </div>
                  </div>
                  <button
                    className="wx-btn wx-btn-ghost"
                    style={{ padding: '6px 10px', fontSize: 12 }}
                    onClick={() => removeDevice(d)}
                  >
                    <XIcon width="13" height="13" /> Remove
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </SectionShell>
  );
}
