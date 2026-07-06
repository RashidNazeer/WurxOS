import { reloadNow } from '../../lib/appUpdate';

// Small, NON-blocking inline notice shown inside a route whose code chunk
// couldn't load after a redeploy. It deliberately does NOT take over the
// screen — the sidebar and other pages stay usable, and the persistent
// "new version" banner at the bottom is the primary Reload prompt. The user
// refreshes on their own terms, once any unsaved work is safe.
export default function ChunkReloadNotice() {
  return (
    <div
      role="status"
      style={{
        margin: '16px 0',
        padding: '10px 14px',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'wrap',
        background: 'var(--surface-2, #f9fafb)',
        border: '1px solid var(--border-subtle, #e5e7eb)',
        borderRadius: 10,
        fontSize: 13,
        color: 'var(--text-secondary)',
      }}
    >
      <i className="bi bi-arrow-clockwise" style={{ color: 'var(--accent)', fontSize: 15 }} />
      <span style={{ flex: 1, minWidth: 200 }}>
        A new version is available, so this page needs a quick refresh. You can
        keep using the rest of the site — reload when your work is saved.
      </span>
      <button
        type="button"
        onClick={reloadNow}
        style={{
          flex: '0 0 auto',
          background: 'var(--accent)',
          color: 'var(--on-accent)',
          border: 'none',
          borderRadius: 8,
          padding: '6px 12px',
          fontSize: 12.5,
          fontWeight: 700,
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <i className="bi bi-arrow-clockwise" /> Reload
      </button>
    </div>
  );
}
