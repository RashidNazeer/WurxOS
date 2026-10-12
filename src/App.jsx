import { Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './lib/queryClient';
import { lazyWithRetry as lazy } from './lib/lazyWithRetry';
import { ThemeProvider } from './contexts/ThemeContext';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ErrorReporterProvider } from './contexts/ErrorReporterContext';
import { NotificationsProvider } from './contexts/NotificationsContext';
import { BrandsProvider } from './contexts/BrandsContext';
import { BuddyProvider } from './contexts/BuddyContext';
import BuddyGate from './components/buddy/BuddyGate';
import ProtectedRoute from './components/auth/ProtectedRoute';
import RoleGuard from './components/auth/RoleGuard';
import AppShell from './components/layout/AppShell';
import AckGate from './components/ack/AckGate';
import { ToastProvider } from './components/ui/Toast';
import { ConfirmProvider } from './components/ui/ConfirmDialog';
import { TextPromptProvider } from './components/common/useDialogs';
import { DEMO_MODE } from './lib/demoMode';
import { LegacyReportRedirect, ReportQueryRedirect } from './routes/redirects';

// Sales-demo role switcher. Behind DEMO_MODE *and* lazy, so a production build
// resolves this to null and never downloads the chunk — the switcher cannot
// appear at work even if someone sets the env var, because demoMode.js refuses
// to turn on against the production database.
const DemoBar = DEMO_MODE ? lazy(() => import('./components/demo/DemoBar')) : null;

// Auth pages are eager — they're the first thing an unauthenticated
// user hits, so we don't want a Suspense flash on the login screen.
import LoginPage from './components/auth/LoginPage';
import SignupPage from './components/auth/SignupPage';

// Lazy pages live in the route registry (src/routes/pages.js) so the shell
// can preload them; App only wires them to paths.
import {
  TodayRouter,
  ReportLinkResolver,
  ApprovalsPage,
  TLsPage,
  PCTLsPage,
  OLsPage,
  APCsPage,
  IPCsPage,
  AdsManagersPage,
  DevelopersPage,
  BrandsPage,
  BrandDetailPage,
  TasksPage,
  PaidCollabBrandsPage,
  PaidCollabCreatorsPage,
  PaidCollabVideosPage,
  PaidCollabDashboardPage,
  PCTLIPCsPage,
  ReportPortalPage,
  HaloPortalPage,
  HaloV2PortalPage,
  ClientPortalPage,
  GmvMaxReportingPage,
  WeeklyReportsRouter,
  BiWeeklyReportsRouter,
  MonthlyReportsRouter,
  ClientAccessPage,
  TeamManagementPage,
  TeamHierarchyPage,
  HolidaysPage,
  LeavePage,
  LeaveApprovalsPage,
  BrandAnalyticsPage,
  AttendancePage,
  ResourcesPage,
  PerformancePage,
  PerformanceSimulatorPage,
  IncentivesPage,
  AchievementsPage,
  CreatorLibraryPage,
  IncentivePlanEditorPage,
  BroadcastsPage,
  ProductCampaignsPage,
  CampaignTrackerPage,
  RemindersPage,
  KnowledgeBasePage,
  ChatPage,
  BrandSwitcherPage,
  TLTeamPage,
  AuditPage,
  SettingsPage,
  NotificationsPage,
  BuddyPage,
  ResourcePlannerPage,
  BossSalariesPage,
  MyCompensationPage,
  BugsPage,
  SuggestionsPage,
  ChangesPage,
  AgendaTasksPage,
  AgendaResourcesPage,
  AgendaSettingsPage,
  AgendaUpcomingPage,
  AgendaOngoingPage,
  AgendaPriorPage,
  AgendaCheckpointPage,
  EukaAnalyticsPage,
  HaloV2Page,
  VideoReviewsPage,
  TikTokCallbackPage,
  DevelopmentLayout,
  DevRoadmapPage,
  DevOverviewPage,
  DevProjectsPage,
  DevProjectPage,
  DevTaskListPage,
  DevBugsPage,
  DevTeamPage,
  DevActivityPage,
} from './routes/pages';

// Roles that read and write brand reports. IPCs are deliberately absent.
const REPORT_ROLES = ['boss', 'ol', 'tl', 'pctl', 'apc'];

// Lightweight fallback for chunk loads — kept minimal so it doesn't
// flash distractingly on fast networks where the chunk arrives in
// a few hundred ms.
function PageFallback() {
  return (
    <div style={{
      display: 'grid', placeItems: 'center', minHeight: '50vh',
      color: 'var(--text-muted)', fontSize: 13,
    }}>
      <span className="wx-spinner" style={{ color: 'var(--accent)' }} />
    </div>
  );
}

function PublicOnly({ children }) {
  const { session, loading } = useAuth();
  // Show a real spinner instead of null while auth bootstraps —
  // returning null leaves the user staring at a blank white page on
  // /login or /signup until the auth call resolves, which on slow
  // networks can look like "the app refreshed and broke."
  if (loading) {
    return (
      <div style={{
        minHeight: '100vh', display: 'grid', placeItems: 'center',
        color: 'var(--text-muted)',
      }}>
        <span className="wx-spinner" style={{ color: 'var(--accent)' }} />
      </div>
    );
  }
  if (session) return <Navigate to="/dashboard" replace />;
  return children;
}

// Dashboard is role-aware. For now only Boss has a real dashboard;
// other roles see a placeholder until we build their features.
// Developers land on Development → Roadmap (owner, 2026-09-16).
function DashboardRouter() {
  const { profile, loading } = useAuth();
  // Render a real spinner while the profile is still loading instead
  // of returning null. Previously this returned null on every render
  // where profile wasn't ready yet, so during a brief refetch / RLS
  // hiccup the dashboard route went blank. Users called it 'blank
  // page after switching pages' — same root cause.
  if (loading || !profile) {
    return (
      <div style={{
        display: 'grid', placeItems: 'center', minHeight: '40vh',
        color: 'var(--text-muted)',
      }}>
        <span className="wx-spinner" style={{ color: 'var(--accent)' }} />
      </div>
    );
  }
  if (profile.role === 'developer') return <Navigate to="/development/roadmap" replace />;
  return <TodayRouter profile={profile} />;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AuthProvider>
          <ErrorReporterProvider>
          <BrowserRouter>
          <ToastProvider>
          <ConfirmProvider>
          <TextPromptProvider>
          <Routes>
            {/* Public */}
            <Route path="/login"  element={<PublicOnly><LoginPage /></PublicOnly>} />
            <Route path="/signup" element={<PublicOnly><SignupPage /></PublicOnly>} />

            {/* Anonymous report portal (no auth required) */}
            <Route
              path="/portal/reports/:token"
              element={<Suspense fallback={<PageFallback />}><ReportPortalPage /></Suspense>}
            />
            <Route
              path="/portal/access/:token"
              element={<Suspense fallback={<PageFallback />}><ClientPortalPage /></Suspense>}
            />
            <Route
              path="/portal/halo/:token"
              element={<Suspense fallback={<PageFallback />}><HaloPortalPage /></Suspense>}
            />
            {/* Two link formats, one view. Links minted by the retired
                original Halo tool (halo_shares) stay on /portal/halo/:token and
                links from the current tool (halo_v2_shares, mig 330) on
                /portal/halo-v2/:token. Each route resolves its own tokens
                through its own RPCs, and both render Amazon Halo, so no client
                holding an old link is sent to a dead page. */}
            <Route
              path="/portal/halo-v2/:token"
              element={<Suspense fallback={<PageFallback />}><HaloV2PortalPage /></Suspense>}
            />

            {/* TikTok Business API OAuth redirect. PUBLIC because the advertiser
                who approves the authorization may have no WurxOS session — a
                client authorising their own ad account never does. The
                single-use `state` nonce the server minted is what makes this
                safe; see supabase/functions/tiktok-oauth. This path must stay
                byte-identical to the redirect URL approved in the TikTok
                developer portal. */}
            <Route
              path="/oauth/tiktok/callback"
              element={<Suspense fallback={<PageFallback />}><TikTokCallbackPage /></Suspense>}
            />

            {/* Protected shell — NotificationsProvider needs an authenticated user.
                Suspense lives inside AppShell's outlet area so the sidebar/topbar
                stay rendered while a route's chunk loads. */}
            <Route element={
              <ProtectedRoute>
                <BrandsProvider>
                  <NotificationsProvider>
                    <BuddyProvider>
                      {/* The Boss's acknowledgement sits over the whole shell
                          (mig 419): nothing below it is reachable until the
                          person acknowledges AND the Boss switches it off. */}
                      <AckGate>
                        <AppShell />
                      </AckGate>
                    </BuddyProvider>
                  </NotificationsProvider>
                </BrandsProvider>
              </ProtectedRoute>
            }>
              <Route path="/"          element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<DashboardRouter />} />
              {/* Wurx Buddy — the roles in ai_assistant_config.allowed_roles,
                  the same list the assistant function enforces. */}
              <Route
                path="/buddy"
                element={
                  <BuddyGate>
                    <BuddyPage />
                  </BuddyGate>
                }
              />
              <Route path="/assistant" element={<Navigate to="/buddy" replace />} />

              {/* Brands — Boss / OL / TL / APC / IPC / Developer (visibility enforced by RLS) */}
              <Route
                path="/brands"
                element={
                  <RoleGuard allow={['boss', 'ol', 'tl', 'apc', 'ipc', 'ads_manager']}>
                    <BrandsPage />
                  </RoleGuard>
                }
              />
              <Route
                path="/brands/:id"
                element={
                  <RoleGuard allow={['boss', 'ol', 'tl', 'pctl', 'apc', 'ipc', 'ads_manager']}>
                    <BrandDetailPage />
                  </RoleGuard>
                }
              />

              {/* Weekly Agenda Meetings — Boss / OL / TL / APC.
                  Settings is OL/Boss/Developer only. */}
              <Route
                path="/agenda/upcoming"
                element={
                  <RoleGuard allow={['boss', 'ol', 'tl', 'apc', 'pctl', 'ipc', 'ads_manager']}>
                    <AgendaUpcomingPage />
                  </RoleGuard>
                }
              />
              <Route
                path="/agenda/ongoing"
                element={
                  <RoleGuard allow={['boss', 'ol', 'tl', 'apc', 'pctl', 'ipc', 'ads_manager']}>
                    <AgendaOngoingPage />
                  </RoleGuard>
                }
              />
              <Route
                path="/agenda/prior"
                element={
                  <RoleGuard allow={['boss', 'ol', 'tl', 'apc', 'pctl', 'ipc', 'ads_manager']}>
                    <AgendaPriorPage />
                  </RoleGuard>
                }
              />
              <Route
                path="/euka"
                element={
                  <RoleGuard allow={['boss']}>
                    <EukaAnalyticsPage />
                  </RoleGuard>
                }
              />
              {/* ONE Amazon Halo (2026-09-21). The original tool that lived
                  here was retired; this is the model that used to be "V2".
                  /halo-v2 redirects rather than 404s, so bookmarks and links
                  pasted into chats keep working. */}
              <Route
                path="/halo"
                element={
                  <RoleGuard allow={['boss', 'ol', 'tl']}>
                    <HaloV2Page />
                  </RoleGuard>
                }
              />
              <Route path="/halo-v2" element={<Navigate to="/halo" replace />} />
              <Route
                path="/video-reviews"
                element={
                  <RoleGuard allow={['apc']}>
                    <VideoReviewsPage />
                  </RoleGuard>
                }
              />
              <Route
                path="/agenda/checkpoint"
                element={
                  <RoleGuard allow={['boss', 'ol', 'tl', 'apc', 'pctl', 'ipc']}>
                    <AgendaCheckpointPage />
                  </RoleGuard>
                }
              />
              <Route
                path="/agenda/tasks"
                element={
                  <RoleGuard allow={['boss', 'ol', 'tl', 'apc', 'pctl', 'ipc', 'ads_manager']}>
                    <AgendaTasksPage />
                  </RoleGuard>
                }
              />
              <Route
                path="/agenda/resources"
                element={
                  <RoleGuard allow={['boss', 'ol', 'tl', 'apc', 'pctl', 'ipc', 'ads_manager']}>
                    <AgendaResourcesPage />
                  </RoleGuard>
                }
              />
              <Route
                path="/agenda/settings"
                element={
                  <RoleGuard allow={['boss', 'ol']}>
                    <AgendaSettingsPage />
                  </RoleGuard>
                }
              />

              {/* Paid Collab */}
              <Route
                path="/paid-collab/dashboard"
                element={
                  <RoleGuard allow="pctl">
                    <PaidCollabDashboardPage />
                  </RoleGuard>
                }
              />
              <Route
                path="/paid-collab/brands"
                element={
                  <RoleGuard allow={['boss', 'ol', 'pctl']}>
                    <PaidCollabBrandsPage />
                  </RoleGuard>
                }
              />
              <Route
                path="/paid-collab/creators"
                element={
                  <RoleGuard allow={['boss', 'ol', 'pctl']}>
                    <PaidCollabCreatorsPage />
                  </RoleGuard>
                }
              />
              <Route
                path="/paid-collab/videos"
                element={
                  <RoleGuard allow={['boss', 'ol', 'pctl']}>
                    <PaidCollabVideosPage />
                  </RoleGuard>
                }
              />
              <Route
                path="/pctl/ipcs"
                element={<RoleGuard allow={['boss', 'ol', 'pctl']}><PCTLIPCsPage /></RoleGuard>}
              />

              {/* Tasks — everyone authenticated (RLS enforces row visibility) */}
              <Route path="/tasks"         element={<TasksPage />} />
              {/* v1-port reports — separate routes per cadence, role-routed inside */}
              {/* Trailing * so the report deep links (F2) can live under each cadence;
                  the pages ignore the extra path until B ships them. IPCs
                  don't write reports (owner, 2026-10-01): the guard sends
                  them to their landing page. */}
              <Route
                path="/weekly-reports/*"
                element={
                  <RoleGuard allow={REPORT_ROLES}>
                    <ReportQueryRedirect><WeeklyReportsRouter /></ReportQueryRedirect>
                  </RoleGuard>
                }
              />
              <Route
                path="/biweekly-reports/*"
                element={
                  <RoleGuard allow={REPORT_ROLES}>
                    <ReportQueryRedirect><BiWeeklyReportsRouter /></ReportQueryRedirect>
                  </RoleGuard>
                }
              />
              <Route
                path="/monthly-reports/*"
                element={
                  <RoleGuard allow={REPORT_ROLES}>
                    <ReportQueryRedirect><MonthlyReportsRouter /></ReportQueryRedirect>
                  </RoleGuard>
                }
              />
              <Route
                path="/r/:reportId"
                element={
                  <RoleGuard allow={REPORT_ROLES}>
                    <ReportLinkResolver />
                  </RoleGuard>
                }
              />
              {/* Approvals inbox (F3). */}
              <Route
                path="/approvals"
                element={
                  <RoleGuard allow={['boss', 'ol', 'tl', 'pctl']}>
                    <ApprovalsPage />
                  </RoleGuard>
                }
              />
              <Route
                path="/gmv-max"
                element={
                  <RoleGuard allow={['boss','ol','tl','pctl','apc','ipc', 'ads_manager']}>
                    <GmvMaxReportingPage />
                  </RoleGuard>
                }
              />
              {/* Back-compat — old /reports* routes redirect to weekly */}
              <Route path="/reports"           element={<Navigate to="/weekly-reports" replace />} />
              <Route path="/reports/gmv-max"   element={<Navigate to="/gmv-max" replace />} />
              <Route path="/reports/new"       element={<Navigate to="/weekly-reports" replace />} />
              <Route path="/reports/:id"       element={<LegacyReportRedirect />} />
              <Route
                path="/client-access"
                element={
                  <RoleGuard allow={['boss','ol']}>
                    <ClientAccessPage />
                  </RoleGuard>
                }
              />
              <Route
                path="/team-management"
                element={
                  <RoleGuard allow={['boss','ol']}>
                    <TeamManagementPage />
                  </RoleGuard>
                }
              />
              <Route
                path="/team-hierarchy"
                element={
                  <RoleGuard allow={['boss','ol']}>
                    <TeamHierarchyPage />
                  </RoleGuard>
                }
              />
              <Route
                path="/achievements"
                element={
                  <RoleGuard allow={['boss','ol']}>
                    <AchievementsPage />
                  </RoleGuard>
                }
              />
              <Route
                path="/holidays"
                element={
                  <RoleGuard allow={['boss']}>
                    <HolidaysPage />
                  </RoleGuard>
                }
              />
              <Route path="/notifications" element={<NotificationsPage />} />
              <Route path="/settings"      element={<SettingsPage />} />

              {/* Attendance */}
              <Route path="/attendance" element={<AttendancePage />} />

              {/* Resources */}
              <Route path="/resources" element={<ResourcesPage />} />

              {/* Performance — staff only (developer excluded; RLS still the boundary) */}
              <Route
                path="/performance"
                element={
                  <RoleGuard allow={['boss', 'ol', 'tl', 'pctl', 'apc', 'ipc']}>
                    <PerformancePage />
                  </RoleGuard>
                }
              />
              {/* Performance Simulator — private read-only what-if tool for one's
                  OWN score (Boss has no personal score, so excluded). */}
              <Route
                path="/performance/simulator"
                element={
                  <RoleGuard allow={['ol', 'tl', 'pctl', 'apc', 'ipc']}>
                    <PerformanceSimulatorPage />
                  </RoleGuard>
                }
              />

              {/* Creator Library — IPC/PCTL/TL/OL (Boss too); RLS is the real boundary */}
              <Route
                path="/creator-library"
                element={
                  <RoleGuard allow={['boss', 'ol', 'tl', 'pctl', 'ipc']}>
                    <CreatorLibraryPage />
                  </RoleGuard>
                }
              />
              {/* Incentives — staff only (developer excluded; RLS still the boundary) */}
              <Route
                path="/incentives"
                element={
                  <RoleGuard allow={['boss', 'ol', 'tl', 'pctl', 'apc', 'ipc', 'ads_manager']}>
                    <IncentivesPage />
                  </RoleGuard>
                }
              />
              <Route
                path="/incentives/new"
                element={
                  <RoleGuard allow={['boss', 'ol', 'tl', 'pctl', 'apc', 'ipc']}>
                    <IncentivePlanEditorPage />
                  </RoleGuard>
                }
              />
              <Route
                path="/incentives/edit/:userId"
                element={
                  <RoleGuard allow={['boss', 'ol', 'tl', 'pctl', 'apc', 'ipc']}>
                    <IncentivePlanEditorPage />
                  </RoleGuard>
                }
              />

              {/* Broadcasts / Reminders / KB / Chat */}
              <Route path="/broadcasts"    element={<BroadcastsPage />} />
              <Route path="/product-campaigns" element={<ProductCampaignsPage />} />
              <Route path="/campaigns" element={<CampaignTrackerPage />} />
              <Route path="/reminders"     element={<RemindersPage />} />
              <Route path="/kb"            element={<KnowledgeBasePage />} />
              <Route
                path="/chat"
                element={
                  <RoleGuard allow={['boss', 'ol', 'tl', 'pctl', 'apc', 'ipc', 'developer', 'ads_manager']}>
                    <ChatPage />
                  </RoleGuard>
                }
              />

              {/* Leave */}
              <Route path="/leave"           element={<LeavePage />} />
              <Route
                path="/leave/approvals"
                element={
                  <RoleGuard allow={['boss', 'ol', 'tl', 'pctl', 'apc', 'ipc']}>
                    <LeaveApprovalsPage />
                  </RoleGuard>
                }
              />

              {/* Analytics */}
              <Route
                path="/analytics/brands"
                element={
                  /* TL/APC/IPC read their own brands only — scoped by RLS (mig 341 & 359),
                     and the page hides every edit control for anyone who is not
                     Boss/OL/developer. */
                  <RoleGuard allow={['boss', 'ol', 'pctl', 'ads_manager', 'tl', 'apc', 'ipc']}>
                    <BrandAnalyticsPage />
                  </RoleGuard>
                }
              />

              {/* Audit log — Boss / OL / Developer */}
              <Route
                path="/audit"
                element={
                  <RoleGuard allow={['boss','ol']}>
                    <AuditPage />
                  </RoleGuard>
                }
              />

              {/* Brand Switcher — Boss / OL reassign brands between APCs */}
              <Route
                path="/brand-switcher"
                element={
                  <RoleGuard allow={['boss', 'ol']}>
                    <BrandSwitcherPage />
                  </RoleGuard>
                }
              />
              {/* Back-compat: old notification URLs point to /boss/brand-switches */}
              <Route
                path="/boss/brand-switches"
                element={<Navigate to="/brand-switcher" replace />}
              />

              {/* TL team */}
              <Route
                path="/tl/team"
                element={<RoleGuard allow="tl"><TLTeamPage /></RoleGuard>}
              />

              {/* Boss-only routes */}
              <Route
                path="/boss/manage/tls"
                element={<RoleGuard allow={['boss', 'ol']}><TLsPage /></RoleGuard>}
              />
              <Route
                path="/boss/manage/pctls"
                element={<RoleGuard allow="boss"><PCTLsPage /></RoleGuard>}
              />
              <Route
                path="/boss/manage/ols"
                element={<RoleGuard allow="boss"><OLsPage /></RoleGuard>}
              />
              <Route
                path="/boss/manage/apcs"
                element={<RoleGuard allow={['boss', 'ol']}><APCsPage /></RoleGuard>}
              />
              <Route
                path="/boss/manage/ipcs"
                element={<RoleGuard allow="boss"><IPCsPage /></RoleGuard>}
              />
              <Route
                path="/boss/manage/ads-managers"
                element={<RoleGuard allow="boss"><AdsManagersPage /></RoleGuard>}
              />
              <Route
                path="/boss/manage/developers"
                element={<RoleGuard allow="boss"><DevelopersPage /></RoleGuard>}
              />

              {/* Resource Planner — Boss only (developer removed, Owner decision; RLS mig 392) */}
              <Route
                path="/boss/resource-planner"
                element={<RoleGuard allow="boss"><ResourcePlannerPage /></RoleGuard>}
              />

              {/* Salary Management — Boss only (no developer access; per spec) */}
              <Route
                path="/boss/salaries"
                element={<RoleGuard allow="boss"><BossSalariesPage /></RoleGuard>}
              />

              {/* Employee's own compensation view — every signed-in user except
                  Boss (Boss has no payroll record). */}
              <Route
                path="/me/compensation"
                element={<MyCompensationPage />}
              />

              {/* Development — the Boss and developers only (RLS is the boundary). */}
              <Route
                path="/development"
                element={
                  <RoleGuard allow={['boss', 'developer']}>
                    <DevelopmentLayout />
                  </RoleGuard>
                }
              >
                <Route index element={<Navigate to="roadmap" replace />} />
                <Route path="roadmap" element={<DevRoadmapPage />} />
                <Route path="overview" element={<DevOverviewPage />} />
                <Route path="projects" element={<DevProjectsPage />} />
                <Route path="projects/:key" element={<DevProjectPage />} />
                <Route path="tasks" element={<DevTaskListPage />} />
                <Route path="bugs" element={<DevBugsPage />} />
                <Route path="team" element={<DevTeamPage />} />
                <Route path="activity" element={<DevActivityPage />} />
                <Route path="*" element={<Navigate to="roadmap" replace />} />
              </Route>
              {/* Links from the previous Development workspace. */}
              <Route path="/dev-tasks/*" element={<Navigate to="/development/roadmap" replace />} />

              {/* Bugs — everyone authenticated (RLS filters rows per role) */}
              <Route path="/bugs"        element={<BugsPage />} />
              <Route path="/suggestions" element={<SuggestionsPage />} />

              {/* Changes — submitters (non-boss/non-dev) + boss review; dev included for ops */}
              <Route
                path="/changes"
                element={
                  <RoleGuard allow={['boss','tl','ol','pctl','apc','ipc','developer']}>
                    <ChangesPage />
                  </RoleGuard>
                }
              />
            </Route>

            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
          {/* Outside <Routes> so it survives navigation, inside the router so a
              future version can link. Also renders on /login, which is where a
              walkthrough starts. */}
          {DemoBar && (
            <Suspense fallback={null}>
              <DemoBar />
            </Suspense>
          )}
          </TextPromptProvider>
          </ConfirmProvider>
          </ToastProvider>
        </BrowserRouter>
          </ErrorReporterProvider>
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
