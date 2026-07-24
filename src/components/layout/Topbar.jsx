import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { maybeGuardLeave } from '../../lib/reportLeaveGuard';
import { useAuth } from '../../contexts/AuthContext';
import { roleLabel } from '../../lib/roles';
import ThemeToggle from '../common/ThemeToggle';
import NotificationBell from './NotificationBell';
import GlobalSearch from './GlobalSearch';
import { ChevronDownIcon, LogoutIcon, UserIcon, SettingsIcon, InstallIcon, MenuIcon } from '../common/Icon';
import { canInstall, onInstallAvailable, promptInstall, isStandalone } from '../../lib/pwa';

export default function Topbar({ title, subtitle, onMobileMenu }) {
  const { user, profile, signOut } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [installable, setInstallable] = useState(canInstall());
  const [pos, setPos] = useState(null);     // portal anchor {top, right}
  const ref = useRef(null);                  // the trigger button wrapper
  const menuRef = useRef(null);              // the portaled menu

  // Outside-click closes the menu. The menu is portaled to <body>, so it is NOT
  // inside `ref` — check both the trigger and the menu.
  useEffect(() => {
    function onDoc(e) {
      if (ref.current && ref.current.contains(e.target)) return;
      if (menuRef.current && menuRef.current.contains(e.target)) return;
      setMenuOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  // Anchor the portaled menu under the trigger; the profile dropdown is portaled
  // (like NotificationBell/GlobalSearch) so it escapes the topbar's z-index:5
  // stacking context and never renders under sticky page toolbars (.ck-topbar etc.).
  useLayoutEffect(() => {
    if (!menuOpen) return undefined;
    const place = () => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setPos({ top: r.bottom + 8, right: Math.max(8, window.innerWidth - r.right) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [menuOpen]);

  useEffect(() => onInstallAvailable(setInstallable), []);

  const standalone = isStandalone();

  const initials = (profile?.display_name || user?.email || '?')
    .split(/\s+/)
    .map((s) => s[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <header className="shell-topbar">
      <div className="shell-topbar-left">
        {onMobileMenu && (
          <button
            type="button"
            className="shell-mobile-menu-btn"
            onClick={onMobileMenu}
            aria-label="Open menu"
          >
            <MenuIcon width="20" height="20" />
          </button>
        )}
        <div className="shell-topbar-titles">
          <div className="shell-topbar-title">{title}</div>
          {subtitle && <div className="shell-topbar-subtitle">{subtitle}</div>}
        </div>
      </div>
      <div className="shell-topbar-right">
        <GlobalSearch />
        <NotificationBell />
        <ThemeToggle />
        <div style={{ position: 'relative' }} ref={ref}>
          <button
            type="button"
            className="shell-user-btn"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <div className="shell-user-avatar">
              {profile?.avatar_url
                ? <img src={profile.avatar_url} alt=""
                    style={{ width: '100%', height: '100%', borderRadius: 'inherit', objectFit: 'cover' }} />
                : initials}
            </div>
            <div className="shell-user-meta">
              <div className="shell-user-name">{profile?.display_name || '—'}</div>
              <div className="shell-user-role">{profile?.role ? roleLabel(profile.role) : ''}</div>
            </div>
            <ChevronDownIcon width="15" height="15" style={{ color: 'var(--text-muted)' }} />
          </button>
          {menuOpen && pos && createPortal(
            <div className="shell-user-menu" ref={menuRef} style={{ top: pos.top, right: pos.right }}>
              <div style={{ padding: '10px 12px' }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                  {profile?.display_name}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {user?.email}
                </div>
              </div>
              <div className="shell-user-menu-divider" />
              <button
                className="shell-user-menu-item"
                onClick={() => { setMenuOpen(false); const go = () => navigate('/settings'); if (!maybeGuardLeave(go)) go(); }}
              >
                <SettingsIcon width="16" height="16" />
                Account &amp; settings
              </button>
              {installable && !standalone && (
                <>
                  <div className="shell-user-menu-divider" />
                  <button
                    className="shell-user-menu-item"
                    onClick={async () => { setMenuOpen(false); await promptInstall(); }}
                  >
                    <InstallIcon width="16" height="16" />
                    Install app
                  </button>
                </>
              )}
              <div className="shell-user-menu-divider" />
              <button className="shell-user-menu-item danger" onClick={signOut}>
                <LogoutIcon width="16" height="16" />
                Sign out
              </button>
            </div>,
            document.body,
          )}
        </div>
      </div>
    </header>
  );
}
