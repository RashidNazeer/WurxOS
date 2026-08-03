import { useCallback, useEffect, useState, Suspense } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import Sidebar from './Sidebar';
import Topbar from './Topbar';
import NotificationToaster from './NotificationToaster';
import ClockInReminder from '../attendance/ClockInReminder';
import RouteErrorBoundary from '../common/RouteErrorBoundary';
import UpdateAvailableBanner from '../common/UpdateAvailableBanner';
import { maybeGuardLeave } from '../../lib/reportLeaveGuard';
import '../../styles/shell.css';

// Suspense fallback for lazy-loaded route chunks. Keeps the shell
// rendered (sidebar, topbar) while the next page's JS arrives.
function RouteFallback() {
  return (
    <div style={{
      display: 'grid', placeItems: 'center', minHeight: '40vh',
      color: 'var(--text-muted)',
    }}>
      <span className="wx-spinner" style={{ color: 'var(--accent)' }} />
    </div>
  );
}

const SIDEBAR_COLLAPSED_KEY = 'wurxos.sidebar.collapsed';

// Per-path page metadata: title + subtitle shown in the Topbar.
// If a path isn't listed, the Topbar falls back to a safe default.
const PAGE_META = {
  '/dashboard':                { title: 'Dashboard',              subtitle: 'Overview of your workspace' },
  '/brands':                   { title: 'Brands',                 subtitle: 'Brand portfolio and assignments' },
  '/tasks':                    { title: 'Tasks',                  subtitle: 'Your tasks, assigned work and personal to-dos' },
  '/reports':                  { title: 'Reports',                subtitle: 'Weekly and bi-weekly brand reports' },
  '/performance/simulator':    { title: 'Performance Simulator',  subtitle: 'A private what-if tool for your own score' },
  '/notifications':            { title: 'Notifications',          subtitle: 'Updates on your work' },
  '/settings':                 { title: 'Settings',               subtitle: 'Your personal preferences' },
  '/boss/manage/tls':          { title: 'Team Leads',             subtitle: 'Affiliate TLs' },
  '/boss/manage/pctls':        { title: 'Paid Collab Team Leads', subtitle: 'PCTLs' },
  '/boss/manage/ols':          { title: 'Operation Leads',        subtitle: 'OLs' },
  '/boss/manage/apcs':         { title: 'APCs',                   subtitle: 'Affiliate Partnership Coordinators' },
  '/boss/manage/ipcs':         { title: 'IPCs',                   subtitle: 'Influencer Partnership Coordinators' },
  '/boss/manage/developers':   { title: 'Developers',             subtitle: 'Engineering team' },
};

export default function AppShell() {
  const { profile } = useAuth();
  const navigate = useNavigate();

  // Collapsed sidebar preference persists across reloads so the user's
  // choice sticks between sessions. Default is expanded.
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'; }
    catch { return false; }
  });
  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0'); } catch {}
      return next;
    });
  }, []);

  // Mobile drawer state — controlled by the hamburger in Topbar.
  // Resets to closed on route change so navigating doesn't leave it open.
  const [mobileOpen, setMobileOpen] = useState(false);
  const openMobile  = useCallback(() => setMobileOpen(true),  []);
  const closeMobile = useCallback(() => setMobileOpen(false), []);

  // Service worker → SPA navigation bridge.
  // When the user clicks "Open" on a push popup, the SW posts a
  // {type:'wurxos-nav', link} message. Handle it via React Router
  // so no full-page reload happens.
  //
  // GUARD: if any form has unsaved work, confirm before navigating
  // away. The autosave hook covers data-loss, but the better UX is
  // to keep the editor mounted so the user doesn't even have to
  // come back and restore. Inspired by the bug where an APC's
  // mid-edit push-notification click destroyed their report.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    function onMessage(e) {
      const m = e.data;
      if (m && m.type === 'wurxos-nav' && typeof m.link === 'string') {
        const go = () => navigate(m.link);
        // Dirty report form → show the Save-as-draft modal instead of leaving.
        if (!maybeGuardLeave(go)) go();
      }
    }
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [navigate]);
  const location = useLocation();
  const meta = PAGE_META[location.pathname] || { title: 'WurxOS', subtitle: '' };

  // Auto-close the mobile drawer on every route change.
  useEffect(() => { setMobileOpen(false); }, [location.pathname]);

  // Lock body scroll while the mobile drawer is open so the underlying
  // page can't scroll behind it.
  useEffect(() => {
    if (mobileOpen) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = prev; };
    }
  }, [mobileOpen]);

  return (
    <div
      className="shell"
      data-collapsed={collapsed ? 'true' : 'false'}
      data-mobile-open={mobileOpen ? 'true' : 'false'}
    >
      <Sidebar
        role={profile?.role}
        menuLayout={profile?.menu_layout}
        collapsed={collapsed}
        onToggle={toggleCollapsed}
        mobileOpen={mobileOpen}
        onMobileClose={closeMobile}
      />
      {mobileOpen && (
        <div
          className="shell-mobile-overlay"
          onClick={closeMobile}
          aria-label="Close menu"
        />
      )}
      <Topbar
        title={meta.title}
        subtitle={meta.subtitle}
        onMobileMenu={openMobile}
      />
      <main className="shell-content">
        <div className="shell-content-inner">
          {/* Error boundary catches render errors in lazy routes so
              a bug on one page doesn't leave the user staring at a
              fully blank screen. Logs to app_events with the stack
              trace. routeKey resets the boundary on navigation so a
              transient error doesn't keep other pages broken. */}
          <RouteErrorBoundary routeKey={location.pathname}>
            <Suspense fallback={<RouteFallback />}>
              <Outlet />
            </Suspense>
          </RouteErrorBoundary>
        </div>
      </main>
      {/* Non-blocking "new version available" banner. Never reloads
          on its own — the user reloads when their work is safe. */}
      <UpdateAvailableBanner />
      {/* Top-right popup queue for incoming notifications. */}
      <NotificationToaster />
      {/* "You forgot to clock in" reminder — silent unless a shift start is set. */}
      <ClockInReminder />
    </div>
  );
}
