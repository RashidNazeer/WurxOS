import { useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { DEMO_MODE, DEMO_PASSWORD } from '../../lib/demoMode';
import { DEMO_USERS, DEMO_COMPANY } from '../../lib/demoRoster';
import './demoBar.css';

// ============================================================
// The demo role switcher.
//
// This app looks like a different product depending on who is signed in — a
// Boss sees payroll and every brand, an APC sees two brands and their own day.
// Showing that is the whole point of a walkthrough, and doing it by logging out
// and back in eight times is not a demo, it is an interruption.
//
// So: one dropdown, pick a person, you are them.
//
// It really does sign in as that account rather than faking a role client-side.
// A faked role would be a lie — RLS would still be answering as the original
// user, so every permission boundary on screen would be theatre and any
// question about security would have a dishonest answer. Signing in properly
// means what the visitor sees is genuinely what that person can see.
//
// Rendered only when DEMO_MODE, which is itself refused against the production
// project (see demoMode.js). App.jsx also lazy-loads it, so a production build
// never even downloads this file.
// ============================================================

const ROLE_LABEL = {
  boss: 'Founder',
  ol: 'Operations Lead',
  tl: 'Team Lead',
  pctl: 'Paid Collab Lead',
  ads_manager: 'Ads Manager',
  apc: 'APC',
  ipc: 'IPC',
  developer: 'Developer',
};

export default function DemoBar() {
  const { profile, session } = useAuth();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(null);   // key of the account being switched to
  const [error, setError] = useState('');
  const [hidden, setHidden] = useState(false);
  const rootRef = useRef(null);

  // Close on outside click / Esc, like every other popover in the app.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!DEMO_MODE) return null;

  const currentEmail = (session?.user?.email || '').toLowerCase();
  const current = DEMO_USERS.find((u) => u.email.toLowerCase() === currentEmail);

  async function switchTo(user) {
    if (busy) return;
    setBusy(user.key);
    setError('');
    try {
      const { error: err } = await supabase.auth.signInWithPassword({
        email: user.email,
        password: DEMO_PASSWORD,
      });
      if (err) throw err;
      // Full reload rather than letting React re-render into the new session.
      // Half this app's data sits in a React Query cache keyed by things that
      // do not include the user id, plus contexts that read the profile once at
      // mount. Reusing them across an identity change is exactly how you end up
      // showing one person's dashboard under another person's name in front of
      // an audience. A reload costs a second and cannot be wrong.
      window.location.assign('/');
    } catch (e) {
      setError(e?.message || 'Could not switch account.');
      setBusy(null);
    }
  }

  if (hidden) {
    return (
      <button
        type="button"
        className="demobar-peek"
        onClick={() => setHidden(false)}
        title="Show the demo role switcher"
      >
        <i className="bi bi-person-badge" /> Demo
      </button>
    );
  }

  return (
    <div className="demobar" ref={rootRef}>
      <span className="demobar-tag">DEMO</span>

      <div className="demobar-who">
        <span className="demobar-company">{DEMO_COMPANY}</span>
        <span className="demobar-sep">·</span>
        {current ? (
          <>
            <strong>{current.name}</strong>
            <span className="demobar-role">{ROLE_LABEL[current.role] || current.role}</span>
          </>
        ) : profile ? (
          <strong>{profile.display_name || 'Signed in'}</strong>
        ) : (
          <span className="demobar-role">Not signed in</span>
        )}
      </div>

      <div className="demobar-actions">
        <button
          type="button"
          className="demobar-btn"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          Switch role <i className={`bi bi-chevron-${open ? 'down' : 'up'}`} />
        </button>
        <button
          type="button"
          className="demobar-x"
          onClick={() => { setOpen(false); setHidden(true); }}
          title="Hide"
          aria-label="Hide the demo bar"
        >
          <i className="bi bi-x-lg" />
        </button>
      </div>

      {open && (
        <div className="demobar-menu" role="menu">
          <div className="demobar-menu-head">
            Sign in as any member of {DEMO_COMPANY}. The app reloads as that
            person — permissions and all.
          </div>
          {error && <div className="demobar-error">{error}</div>}
          <div className="demobar-list">
            {DEMO_USERS.map((u) => {
              const isCurrent = u.email.toLowerCase() === currentEmail;
              return (
                <button
                  key={u.key}
                  type="button"
                  role="menuitem"
                  className={`demobar-item${isCurrent ? ' is-current' : ''}`}
                  disabled={!!busy || isCurrent}
                  onClick={() => switchTo(u)}
                >
                  <span className="demobar-item-main">
                    <span className="demobar-item-name">{u.name}</span>
                    <span className="demobar-item-role">
                      {ROLE_LABEL[u.role] || u.role}
                    </span>
                  </span>
                  <span className="demobar-item-blurb">{u.blurb}</span>
                  {busy === u.key && <span className="demobar-item-flag">signing in…</span>}
                  {isCurrent && <span className="demobar-item-flag">you</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
