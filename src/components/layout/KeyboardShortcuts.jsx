import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { XIcon } from '../common/Icon';

// Global keyboard map. (Ctrl+K is handled by GlobalSearch itself.)
const ROUTES = [
  { combo: 'g then d', go: '/dashboard',     label: 'Dashboard' },
  { combo: 'g then b', go: '/brands',        label: 'Brands' },
  { combo: 'g then t', go: '/tasks',         label: 'Tasks' },
  { combo: 'g then r', go: '/reports',       label: 'Reports' },
  { combo: 'g then l', go: '/leave',         label: 'Leave' },
  { combo: 'g then n', go: '/notifications', label: 'Notifications' },
  { combo: 'g then s', go: '/settings',      label: 'Settings' },
];

export default function KeyboardShortcuts() {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [helpOpen, setHelpOpen] = useState(false);
  const [primed, setPrimed]     = useState(false); // "g" was just pressed

  useEffect(() => {
    let primeTimer;
    function onKey(e) {
      // Ignore when the user is typing in any input/textarea/contenteditable
      const tag = document.activeElement?.tagName;
      const editable = document.activeElement?.isContentEditable;
      if (editable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (e.key === '?') { e.preventDefault(); setHelpOpen((v) => !v); return; }
      if (e.key === 'Escape' && helpOpen) { setHelpOpen(false); return; }

      if (!primed && (e.key === 'g' || e.key === 'G')) {
        setPrimed(true);
        clearTimeout(primeTimer);
        primeTimer = setTimeout(() => setPrimed(false), 1200);
        return;
      }
      if (primed) {
        clearTimeout(primeTimer);
        setPrimed(false);
        const match = ROUTES.find((r) => r.combo.endsWith(e.key.toLowerCase()));
        if (match) { e.preventDefault(); navigate(match.go); }
      }
    }
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); clearTimeout(primeTimer); };
  }, [navigate, helpOpen, primed]);

  if (!profile) return null;

  return (
    <>
      {primed && (
        <div style={{
          position: 'fixed', bottom: 20, right: 20, zIndex: 1400,
          padding: '8px 12px', background: 'var(--accent)', color: 'var(--on-accent)',
          borderRadius: 'var(--radius-md)', fontWeight: 700, fontSize: 13,
          boxShadow: 'var(--shadow-lg)',
        }}>
          Press second key… (d/b/t/r/l/n/s)
        </div>
      )}

      {helpOpen && (
        <div className="wx-modal-backdrop" onClick={() => setHelpOpen(false)}>
          <div className="wx-modal" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
            <div className="wx-modal-header">
              <div className="wx-modal-title">Keyboard shortcuts</div>
              <button type="button" className="shell-icon-btn" onClick={() => setHelpOpen(false)} aria-label="Close">
                <XIcon width="16" height="16" />
              </button>
            </div>
            <div className="wx-modal-body">
              <Row kbd="?" label="Toggle this help" />
              <Row kbd="Ctrl / ⌘ + K" label="Global search" />
              <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '14px 0 6px' }}>
                Navigation (press g, then…)
              </div>
              {ROUTES.map((r) => (
                <Row key={r.go} kbd={r.combo} label={r.label} />
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Row({ kbd, label }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '6px 2px',
    }}>
      <span style={{ fontSize: 13.5, color: 'var(--text-primary)' }}>{label}</span>
      <span style={{
        fontFamily: 'ui-monospace, monospace', fontSize: 11.5,
        background: 'var(--surface-2)', border: '1px solid var(--border-subtle)',
        padding: '2px 8px', borderRadius: 4, color: 'var(--text-secondary)',
      }}>{kbd}</span>
    </div>
  );
}
