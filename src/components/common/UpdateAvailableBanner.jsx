import { useEffect, useState } from 'react';
import { isUpdateAvailable, subscribeUpdate, reloadNow } from '../../lib/appUpdate';

// Non-blocking "a new version is available" banner. Appears when a
// new deploy is detected (proactive poll, or a failed chunk import).
// It never reloads on its own — the user clicks Reload when their
// work is safe. Dismissible; it reappears if a broken chunk is hit.
export default function UpdateAvailableBanner() {
  const [show, setShow] = useState(isUpdateAvailable());
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => subscribeUpdate((v) => {
    setShow(v);
    if (v) setDismissed(false); // a fresh signal un-dismisses
  }), []);

  if (!show || dismissed) return null;

  return (
    <div
      role="status"
      style={{
        position: 'fixed',
        left: '50%',
        bottom: 20,
        transform: 'translateX(-50%)',
        zIndex: 6000,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        maxWidth: 'calc(100vw - 32px)',
        padding: '10px 12px 10px 16px',
        borderRadius: 12,
        background: 'var(--surface-1)',
        border: '1px solid var(--border-default, var(--border-subtle))',
        boxShadow: '0 12px 32px -8px rgba(0,0,0,0.35)',
        color: 'var(--text-primary)',
        fontSize: 13,
      }}
    >
      <i className="bi bi-stars" style={{ color: 'var(--accent)', fontSize: 15 }} />
      <span style={{ color: 'var(--text-secondary)' }}>
        A new version of WurxOS is available.{' '}
        <span style={{ color: 'var(--text-muted)' }}>Your unsaved work is safe until you reload.</span>
      </span>
      <button
        type="button"
        onClick={reloadNow}
        style={{
          flex: '0 0 auto',
          background: 'var(--accent)', color: 'var(--on-accent)',
          border: 'none', borderRadius: 8,
          padding: '6px 12px', fontSize: 12.5, fontWeight: 700,
          cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', gap: 6,
        }}
      >
        <i className="bi bi-arrow-clockwise" /> Reload
      </button>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        style={{
          flex: '0 0 auto',
          background: 'transparent', border: 'none',
          color: 'var(--text-muted)', cursor: 'pointer',
          fontSize: 16, lineHeight: 1, padding: '2px 4px',
        }}
      >
        ×
      </button>
    </div>
  );
}
