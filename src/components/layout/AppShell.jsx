import { useCallback, useEffect, useLayoutEffect, useRef, useState, Suspense } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import Sidebar from './Sidebar';
import Topbar from './Topbar';
import NotificationToaster from './NotificationToaster';
import ClockInReminder from '../attendance/ClockInReminder';
import AchievementCelebration from '../achievements/AchievementCelebration';
import RouteErrorBoundary from '../common/RouteErrorBoundary';
import UpdateAvailableBanner from '../common/UpdateAvailableBanner';
import BuddyFab from '../buddy/BuddyFab';
import { maybeGuardLeave } from '../../lib/reportLeaveGuard';
import '../../styles/shell.css';

// Suspense fallback for lazy-loaded route chunks. Keeps the shell
// rendered (sidebar, topbar) while the next page's JS arrives.
function RouteFallback() {
  return (
    <div className="route-fallback" style={{
      display: 'grid', placeItems: 'center', minHeight: '40vh',
      color: 'var(--text-muted)',
    }}>
      <span className="wx-spinner" style={{ color: 'var(--accent)' }} />
    </div>
  );
}

const SIDEBAR_COLLAPSED_KEY = 'wurxos.sidebar.collapsed';

// Topbar title + subtitle per route. Title = the sidebar label (Title Case);
// role names follow lib/roles.js. Exact paths first, then PAGE_META_PREFIX
// (longest prefix wins) for dynamic routes; unknown paths fall back to WurxOS.
const AGENDA = 'Weekly agenda';
const PAID = 'Paid Collab';
const REPORTING = 'Reporting';
const DEV = 'Development';
const PAGE_META = {
  '/dashboard':               { title: 'Dashboard',              subtitle: 'Overview of your workspace' },
  '/buddy':                   { title: 'Wurx Buddy',             subtitle: 'Here to help, explore and grow' },
  '/brands':                  { title: 'Brands',                 subtitle: 'Brand portfolio and assignments' },
  '/agenda/upcoming':         { title: 'Upcoming Meetings',      subtitle: AGENDA },
  '/agenda/ongoing':          { title: 'Ongoing Meetings',       subtitle: AGENDA },
  '/agenda/prior':            { title: 'Prior Meetings',         subtitle: AGENDA },
  '/agenda/checkpoint':       { title: 'Weekly Checkpoint',      subtitle: AGENDA },
  '/agenda/tasks':            { title: 'Agenda Tasks',           subtitle: AGENDA },
  '/agenda/resources':        { title: 'Agenda Resources',       subtitle: AGENDA },
  '/agenda/settings':         { title: 'Agenda Settings',        subtitle: AGENDA },
  '/euka':                    { title: 'Euka Analytics',         subtitle: 'TikTok Shop metrics' },
  '/halo':                    { title: 'Amazon Halo',            subtitle: 'Halo effect analysis' },
  '/video-reviews':           { title: 'Video Reviews',          subtitle: 'Daily review targets' },
  '/paid-collab/dashboard':   { title: 'Paid Collab Dashboard',  subtitle: PAID },
  '/paid-collab/brands':      { title: 'Paid Collab Brands',     subtitle: PAID },
  '/paid-collab/creators':    { title: 'Paid Collab Creators',   subtitle: PAID },
  '/paid-collab/videos':      { title: 'Paid Collab Videos',     subtitle: PAID },
  '/pctl/ipcs':               { title: 'Influencer Coordinators', subtitle: 'IPCs on your team' },
  '/tasks':                   { title: 'Tasks',                  subtitle: 'Your tasks, assigned work and personal to-dos' },
  '/weekly-reports':          { title: 'Weekly Reports',         subtitle: REPORTING },
  '/biweekly-reports':        { title: 'Bi-Weekly Reports',      subtitle: REPORTING },
  '/monthly-reports':         { title: 'Monthly Reports',        subtitle: REPORTING },
  '/gmv-max':                 { title: 'GMV Max',                subtitle: REPORTING },
  '/client-access':           { title: 'Client Access',          subtitle: 'Client portal links' },
  '/team-management':         { title: 'Team Management',        subtitle: 'Brand switcher and APC lead reassignment' },
  '/team-hierarchy':          { title: 'Team Hierarchy',         subtitle: 'Who reports to whom' },
  '/achievements':            { title: 'Achievements',           subtitle: 'Team milestones' },
  '/holidays':                { title: 'Holidays',               subtitle: 'Company holiday calendar' },
  '/notifications':           { title: 'Notifications',          subtitle: 'Updates on your work' },
  '/settings':                { title: 'Settings',               subtitle: 'Your personal preferences' },
  '/attendance':              { title: 'Attendance',             subtitle: 'Clock in, breaks and history' },
  '/resources':               { title: 'Resources',              subtitle: 'Shared links, docs and tools' },
  '/performance':             { title: 'Performance',            subtitle: 'Scores and flags' },
  '/performance/simulator':   { title: 'Performance Simulator',  subtitle: 'A private what-if tool for your own score' },
  '/creator-library':         { title: 'Creator Library',        subtitle: 'Creators by brand' },
  '/incentives':              { title: 'Incentives',             subtitle: 'Monthly incentive plans and payouts' },
  '/incentives/new':          { title: 'New Incentive Plan',     subtitle: 'Incentives' },
  '/broadcasts':              { title: 'Broadcasts',             subtitle: 'Company announcements' },
  '/product-campaigns':       { title: 'Product Campaigns',      subtitle: 'Campaigns' },
  '/campaigns':               { title: 'Campaigns',              subtitle: 'Campaign tracker' },
  '/reminders':               { title: 'Reminders',              subtitle: 'Your reminders' },
  '/kb':                      { title: 'Knowledge Base',         subtitle: 'SOPs and policies' },
  '/chat':                    { title: 'Chat',                   subtitle: 'Team messages' },
  '/leave':                   { title: 'Leave',                  subtitle: 'Requests and approvals' },
  '/leave/approvals':         { title: 'Leave',                  subtitle: 'Requests and approvals' },
  '/analytics/brands':        { title: 'Brand Analytics',        subtitle: 'Brand performance' },
  '/audit':                   { title: 'Audit Log',              subtitle: 'Changes across the workspace' },
  '/brand-switcher':          { title: 'Brand Switcher',         subtitle: 'Brand switch requests' },
  '/tl/team':                 { title: 'My Team',                subtitle: 'Your coordinators' },
  '/boss/manage/tls':         { title: 'Team Leads',             subtitle: 'TLs' },
  '/boss/manage/pctls':       { title: 'Paid Collab Team Leads', subtitle: 'PCTLs' },
  '/boss/manage/ols':         { title: 'Operation Leads',        subtitle: 'OLs' },
  '/boss/manage/apcs':        { title: 'Affiliate Coordinators', subtitle: 'APCs' },
  '/boss/manage/ipcs':        { title: 'Influencer Coordinators', subtitle: 'IPCs' },
  '/boss/manage/ads-managers':{ title: 'Ads Managers',           subtitle: 'Paid ads / GMV Max' },
  '/boss/manage/developers':  { title: 'Developers',             subtitle: 'Engineering team' },
  '/boss/resource-planner':   { title: 'Resource Planner',       subtitle: 'Capacity and allocation' },
  '/boss/salaries':           { title: 'Salaries',               subtitle: 'Compensation and history' },
  '/me/compensation':         { title: 'My Compensation',        subtitle: 'Your salary and history' },
  '/development/roadmap':     { title: 'Roadmap',                subtitle: DEV },
  '/development/overview':    { title: 'Overview',               subtitle: DEV },
  '/development/projects':    { title: 'Projects',               subtitle: DEV },
  '/development/tasks':       { title: 'All Tasks',              subtitle: DEV },
  '/development/bugs':        { title: 'Bugs',                   subtitle: DEV },
  '/development/team':        { title: 'Team',                   subtitle: DEV },
  '/development/activity':    { title: 'Activity',               subtitle: DEV },
  '/bugs':                    { title: 'Bug Reports',            subtitle: 'Report a problem' },
  '/suggestions':             { title: 'Suggestions',            subtitle: 'Ideas for WurxOS' },
  '/changes':                 { title: 'Change Management',      subtitle: 'SOP change requests' },
};
const PAGE_META_PREFIX = [
  ['/brands/',               { title: 'Brand',                subtitle: '' }],
  ['/incentives/edit/',      { title: 'Edit Incentive Plan',  subtitle: 'Incentives' }],
  ['/development/projects/', { title: 'Project',              subtitle: DEV }],
  ['/development',           { title: 'Development',          subtitle: 'Product roadmap, tasks and releases' }],
].sort((a, b) => b[0].length - a[0].length);
const DEFAULT_META = { title: 'WurxOS', subtitle: '' };

function metaFor(pathname) {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (PAGE_META[path]) return PAGE_META[path];
  const hit = PAGE_META_PREFIX.find(([prefix]) => path.startsWith(prefix));
  return hit ? hit[1] : DEFAULT_META;
}

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
  const meta = metaFor(location.pathname);

  // Auto-close the mobile drawer on every route change.
  useEffect(() => { setMobileOpen(false); }, [location.pathname]);

  // Route change fade: restart a CSS animation by toggling a class instead
  // of keying the subtree, so nothing remounts that wouldn't anyway.
  const pageRef = useRef(null);
  const firstRoute = useRef(true);
  useLayoutEffect(() => {
    const el = pageRef.current;
    if (!el) return;
    if (firstRoute.current) { firstRoute.current = false; return; }
    el.classList.remove('route-enter');
    void el.offsetWidth; // restart the animation
    el.classList.add('route-enter');
  }, [location.pathname]);

  // Lock body scroll while the mobile drawer is open so the underlying
  // page can't scroll behind it.
  useEffect(() => {
    if (mobileOpen) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = prev; };
    }
  }, [mobileOpen]);

  // Full-height pages (the Buddy tab): the shell is exactly the viewport and
  // only the page's own panels scroll, so the sidebar and topbar never move.
  // Every other page keeps normal document scrolling.
  const fill = location.pathname === '/buddy';

  return (
    <div
      className="shell"
      data-collapsed={collapsed ? 'true' : 'false'}
      data-mobile-open={mobileOpen ? 'true' : 'false'}
      data-fill={fill ? 'true' : undefined}
    >
      <Sidebar
        role={profile?.role}
        menuLayout={profile?.menu_layout}
        collapsed={collapsed}
        onToggle={toggleCollapsed}
        mobileOpen={mobileOpen}
        onMobileClose={closeMobile}
      />
      {/* Always mounted (hidden by CSS when closed) so it can fade out. */}
      <div className="shell-mobile-overlay" onClick={closeMobile} aria-hidden="true" />

      <Topbar
        title={meta.title}
        subtitle={meta.subtitle}
        onMobileMenu={openMobile}
      />
      <main className="shell-content" tabIndex={-1}>
        <div className="shell-content-inner" ref={pageRef}>
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
      {/* Renders nothing unless this user has an announced award waiting. It
          must be able to appear over any page, because the winner could be
          anywhere when the Boss hits Announce. */}
      <AchievementCelebration />
      {/* Wurx Buddy, bottom-right on every page but its own tab. */}
      <BuddyFab />
    </div>
  );
}
