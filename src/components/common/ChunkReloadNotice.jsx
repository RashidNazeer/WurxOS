import { reloadNow } from '../../lib/appUpdate';

// Shown in place of a route whose code chunk could not be loaded
// after a redeploy, when the app chose NOT to auto-reload because
// the user may have unsaved work elsewhere. Non-destructive: the
// user reloads on their own terms once their work is safe.
export default function ChunkReloadNotice() {
  return (
    <div style={{
      margin: '48px auto', maxWidth: 440, padding: 24,
      background: 'var(--surface-1)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 16, textAlign: 'center',
      boxShadow: 'var(--shadow-lg, 0 10px 40px rgba(0,0,0,0.18))',
    }}>
      <div style={{
        width: 48, height: 48, margin: '0 auto 12px',
        borderRadius: '50%',
        background: 'var(--info-soft, #e0f2fe)', color: 'var(--info, #0284c7)',
        display: 'grid', placeItems: 'center', fontSize: 22,
      }}>
        <i className="bi bi-arrow-clockwise" />
      </div>
      <h2 style={{ margin: '0 0 6px', fontSize: 17, color: 'var(--text-primary)' }}>
        A new version is available
      </h2>
      <p style={{ color: 'var(--text-secondary)', fontSize: 13.5, margin: '0 0 18px', lineHeight: 1.55 }}>
        This page needs a quick refresh to load the latest version of
        WurxOS. If you have unsaved changes on another tab or page,
        save them first — then reload.
      </p>
      <button
        type="button"
        onClick={reloadNow}
        className="wx-btn wx-btn-primary"
        style={{ width: '100%', justifyContent: 'center' }}
      >
        <i className="bi bi-arrow-clockwise me-1" /> Reload now
      </button>
    </div>
  );
}
