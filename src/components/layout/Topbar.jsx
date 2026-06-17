import { useEffect, useRef, useState } from 'react';
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
  const ref = useRef(null);

  useEffect(() => {
    function onDoc(e) {
      if (ref.current && !ref.current.contains(e.target)) setMenuOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

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
          {menuOpen && (
            <div className="shell-user-menu">
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
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
