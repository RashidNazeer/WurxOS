import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { bottomTabsFor } from './navStructure';
import { MoreIcon } from '../common/Icon';
import UnreadDot from './UnreadDot';
import { useApprovalsCount } from '../../lib/approvalsBadge';
import { preloadPath } from '../../routes/pages';

// Phones/tablets (≤860px, the shell breakpoint): 4 role tabs + More (opens
// the full drawer). Hidden on Buddy (fill mode), in report editors (their
// own save bar owns the bottom) and while the on-screen keyboard is up.
// Tabs are NavLinks, so the report leave-guard still intercepts them.
const EDITOR_PATH = /\/(new|edit)\/?$/;

function useKeyboardOpen() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return undefined;
    const check = () => setOpen(vv.height < window.innerHeight * 0.75);
    check();
    vv.addEventListener('resize', check);
    return () => vv.removeEventListener('resize', check);
  }, []);
  return open;
}

export default function BottomTabBar({ role, onMore, moreOpen = false }) {
  const { pathname } = useLocation();
  const keyboard = useKeyboardOpen();
  const hidden = pathname.startsWith('/buddy') || EDITOR_PATH.test(pathname) || keyboard;
  const tabs = bottomTabsFor(role);

  // Other fixed UI (Buddy FAB, toasts, page padding) lifts by this amount.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('has-bottom-bar', !hidden);
    return () => root.classList.remove('has-bottom-bar');
  }, [hidden]);

  if (hidden) return null;

  return (
    <nav className="shell-bottom-bar" aria-label="Quick navigation">
      {tabs.map((t) => (
        <NavLink
          key={t.key}
          to={t.to}
          end={t.to === '/dashboard'}
          className={({ isActive }) => `shell-bottom-tab${isActive ? ' is-active' : ''}`}
          onPointerEnter={() => preloadPath(t.to)}
          onTouchStart={() => preloadPath(t.to)}
          onFocus={() => preloadPath(t.to)}
        >
          <span className="shell-bottom-tab__icon">
            <t.icon width="20" height="20" aria-hidden="true" />
            {t.category && <UnreadDot category={t.category} />}
            {t.badge === 'approvals' && <ApprovalsCount />}
          </span>
          <span className="shell-bottom-tab__label">{t.label}</span>
        </NavLink>
      ))}
      <button
        type="button"
        className={`shell-bottom-tab${moreOpen ? ' is-active' : ''}`}
        onClick={onMore}
        aria-label="More: open the full menu"
        aria-expanded={moreOpen}
      >
        <span className="shell-bottom-tab__icon"><MoreIcon width="20" height="20" aria-hidden="true" /></span>
        <span className="shell-bottom-tab__label">More</span>
      </button>
    </nav>
  );
}

function ApprovalsCount() {
  const n = useApprovalsCount();
  if (!n) return null;
  return <span className="shell-bottom-tab__badge" aria-label={`${n} waiting`}>{n > 99 ? '99+' : n}</span>;
}
