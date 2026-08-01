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
import ProtectedRoute from './components/auth/ProtectedRoute';
import RoleGuard from './components/auth/RoleGuard';
import AppShell from './components/layout/AppShell';

// Auth pages are eager — they're the first thing an unauthenticated
// user hits, so we don't want a Suspense flash on the login screen.
import LoginPage from './components/auth/LoginPage';
import SignupPage from './components/auth/SignupPage';

// Every other page is code-split via React.lazy. Each becomes its own
// chunk that downloads only when its route is hit. This shrinks the
// initial bundle from ~1.6MB to a few hundred KB and makes the first
// paint dramatically faster.
const BossDashboard         = lazy(() => import('./pages/boss/BossDashboard'));
const RoleDashboard         = lazy(() => import('./pages/dashboards/RoleDashboard'));
const TLsPage               = lazy(() => import('./pages/boss/manage/TLsPage'));
const PCTLsPage             = lazy(() => import('./pages/boss/manage/PCTLsPage'));
const OLsPage               = lazy(() => import('./pages/boss/manage/OLsPage'));
const APCsPage              = lazy(() => import('./pages/boss/manage/APCsPage'));
const IPCsPage              = lazy(() => import('./pages/boss/manage/IPCsPage'));
const DevelopersPage        = lazy(() => import('./pages/boss/manage/DevelopersPage'));
const BrandsPage            = lazy(() => import('./pages/brands/BrandsPage'));
const BrandDetailPage       = lazy(() => import('./pages/brands/BrandDetailPage'));
const TasksPage             = lazy(() => import('./pages/tasks/TasksPage'));
const PaidCollabBrandsPage  = lazy(() => import('./pages/paidCollab/BrandsPage'));
const PaidCollabCreatorsPage= lazy(() => import('./pages/paidCollab/CreatorsPage'));
const PaidCollabVideosPage  = lazy(() => import('./pages/paidCollab/VideosPage'));
const PaidCollabDashboardPage = lazy(() => import('./pages/paidCollab/DashboardPage'));
const PCTLIPCsPage          = lazy(() => import('./pages/pctl/IPCsPage'));
const ReportPortalPage      = lazy(() => import('./pages/portal/ReportPortalPage'));
const HaloPortalPage        = lazy(() => import('./pages/portal/HaloPortalPage'));
const ClientPortalPage      = lazy(() => import('./pages/portal/ClientPortalPage'));
const GmvMaxReportingPage   = lazy(() => import('./components/reporting/GmvMaxReportingPage'));
const WeeklyReportsRouter   = lazy(() => import('./components/reporting/WeeklyReportsRouter'));
const BiWeeklyReportsRouter = lazy(() => import('./components/reporting/BiWeeklyReportsRouter'));
const MonthlyReportsRouter  = lazy(() => import('./components/reporting/MonthlyReportsRouter'));
const ClientAccessPage      = lazy(() => import('./pages/clientAccess/ClientAccessPage'));
// v1 verbatim port — tabbed Brand Switcher + Reassign APC Lead. Replaces
// v2's bespoke single-roster page.
const TeamManagementPage    = lazy(() => import('./components/teamManagement/TeamManagementPage'));
const TeamHierarchyPage     = lazy(() => import('./pages/teamManagement/TeamHierarchyPage'));
const HolidaysPage          = lazy(() => import('./pages/holidays/HolidaysPage'));
const LeavePage             = lazy(() => import('./components/leave/LeaveRouter'));
const LeaveApprovalsPage    = lazy(() => import('./components/leave/LeaveRouter'));
const BrandAnalyticsPage    = lazy(() => import('./pages/analytics/BrandAnalyticsPage'));
// Replaced the v2-original page with the v1-port that lives under
// components/attendance. Keeps the /attendance route + menu link
// pointing at the new file.
const AttendancePage        = lazy(() => import('./components/attendance/AttendancePage'));
// v1 verbatim port replaces the v2-original ResourcesPage. The v1 file
// (components/resources/AllResourcesPage.jsx) uses Bootstrap-styled
// brand cards + general visibility model (private/user/group/office).
const ResourcesPage         = lazy(() => import('./components/resources/AllResourcesPage'));
// Replaced the v2-original page with the v1-port that lives under
// components/performance. Keeps the /performance route + menu link
// pointing at the new file.
const PerformancePage       = lazy(() => import('./components/performance/PerformancePage'));
// Replaced the v2-original single-page Incentives with v1-style
// per-role pages, dispatched by IncentivesRouter. The plan editor
// (IncentiveForm) is shared between Boss and OL via /incentives/edit/:userId.
const IncentivesPage        = lazy(() => import('./components/incentives/IncentivesRouter'));
const CreatorLibraryPage    = lazy(() => import('./pages/creators/CreatorLibraryPage'));
const IncentivePlanEditorPage = lazy(() => import('./components/incentives/IncentiveForm'));
const BroadcastsPage        = lazy(() => import('./pages/broadcasts/BroadcastsPage'));
// Replaced v2-original campaigns pages with v1 verbatim ports under
// components/campaigns. Routes + menu links unchanged.
const ProductCampaignsPage  = lazy(() => import('./components/campaigns/ProductCampaignsPage'));
const CampaignTrackerPage   = lazy(() => import('./components/campaigns/CampaignTrackerPage'));
const RemindersPage         = lazy(() => import('./pages/reminders/RemindersPage'));
const KnowledgeBasePage     = lazy(() => import('./components/knowledge/KnowledgeBaseRouter'));
const ChatPage              = lazy(() => import('./pages/chat/ChatPage'));
const BrandSwitcherPage     = lazy(() => import('./pages/brands/BrandSwitcherPage'));
const TLTeamPage            = lazy(() => import('./pages/tl/TeamPage'));
const AuditPage             = lazy(() => import('./pages/audit/AuditPage'));
const SettingsPage          = lazy(() => import('./pages/settings/SettingsPage'));
const NotificationsPage     = lazy(() => import('./pages/notifications/NotificationsPage'));
const AiAssistantPage       = lazy(() => import('./pages/assistant/AiAssistantPage'));
const ReportsPage           = lazy(() => import('./pages/reports/ReportsPage'));
const ReportPage            = lazy(() => import('./pages/reports/ReportPage'));
const ResourcePlannerPage   = lazy(() => import('./pages/resourcePlanner/ResourcePlannerPage'));
const BossSalariesPage      = lazy(() => import('./pages/boss/salaries/BossSalariesPage'));
const MyCompensationPage    = lazy(() => import('./pages/me/MyCompensationPage'));
const BugsPage              = lazy(() => import('./pages/bugs/BugsPage'));
const SuggestionsPage       = lazy(() => import('./pages/suggestions/SuggestionsPage'));
// v1 verbatim port — boss gets BossChangeManagementPage, others get
// the submitter-side ChangeManagementPage. Routed via the role router.
const ChangesPage           = lazy(() => import('./components/changes/ChangeManagementRouter'));
const AgendaTasksPage       = lazy(() => import('./pages/agenda/AgendaTasksPage'));
const AgendaResourcesPage   = lazy(() => import('./pages/agenda/AgendaResourcesPage'));
const AgendaSettingsPage    = lazy(() => import('./pages/agenda/AgendaSettingsPage'));
const AgendaUpcomingPage    = lazy(() => import('./pages/agenda/AgendaUpcomingPage'));
const AgendaOngoingPage     = lazy(() => import('./pages/agenda/AgendaOngoingPage'));
const AgendaPriorPage       = lazy(() => import('./pages/agenda/AgendaPriorPage'));
const AgendaCheckpointPage  = lazy(() => import('./pages/agenda/AgendaCheckpointPage'));
const EukaAnalyticsPage     = lazy(() => import('./pages/euka/EukaAnalyticsPage'));
const AmazonHaloPage        = lazy(() => import('./pages/boss/AmazonHaloPage'));
const VideoReviewsPage      = lazy(() => import('./pages/video-reviews/VideoReviewsPage'));

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
// Developers land directly on the bug triage page — same pattern
// as v1's /dev/dashboard = DevBugDashboard.
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
  if (profile.role === 'developer') return <Navigate to="/bugs" replace />;
  if (profile.role === 'boss')      return <BossDashboard />;
  return <RoleDashboard />;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AuthProvider>
          <ErrorReporterProvider>
          <BrowserRouter>
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

            {/* Protected shell — NotificationsProvider needs an authenticated user.
                Suspense lives inside AppShell's outlet area so the sidebar/topbar
                stay rendered while a route's chunk loads. */}
            <Route element={
              <ProtectedRoute>
                <BrandsProvider>
                  <NotificationsProvider>
                    <AppShell />
                  </NotificationsProvider>
                </BrandsProvider>
              </ProtectedRoute>
            }>
              <Route path="/"          element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<DashboardRouter />} />
              <Route
                path="/assistant"
                element={
                  <RoleGuard allow={['boss']}>
                    <AiAssistantPage />
                  </RoleGuard>
                }
              />

              {/* Brands — Boss / OL / TL / APC / IPC / Developer (visibility enforced by RLS) */}
              <Route
                path="/brands"
                element={
                  <RoleGuard allow={['boss', 'ol', 'tl', 'apc', 'ipc']}>
                    <BrandsPage />
                  </RoleGuard>
                }
              />
              <Route
                path="/brands/:id"
                element={
                  <RoleGuard allow={['boss', 'ol', 'tl', 'pctl', 'apc', 'ipc']}>
                    <BrandDetailPage />
                  </RoleGuard>
                }
              />

              {/* Weekly Agenda Meetings — Boss / OL / TL / APC.
                  Settings is OL/Boss/Developer only. */}
              <Route
                path="/agenda/upcoming"
                element={
                  <RoleGuard allow={['boss', 'ol', 'tl', 'apc', 'pctl', 'ipc']}>
                    <AgendaUpcomingPage />
                  </RoleGuard>
                }
              />
              <Route
                path="/agenda/ongoing"
                element={
                  <RoleGuard allow={['boss', 'ol', 'tl', 'apc', 'pctl', 'ipc']}>
                    <AgendaOngoingPage />
                  </RoleGuard>
                }
              />
              <Route
                path="/agenda/prior"
                element={
                  <RoleGuard allow={['boss', 'ol', 'tl', 'apc', 'pctl', 'ipc']}>
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
              <Route
                path="/halo"
                element={
                  <RoleGuard allow={['boss', 'ol', 'tl']}>
                    <AmazonHaloPage />
                  </RoleGuard>
                }
              />
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
                  <RoleGuard allow={['boss', 'ol', 'tl', 'apc', 'pctl', 'ipc']}>
                    <AgendaTasksPage />
                  </RoleGuard>
                }
              />
              <Route
                path="/agenda/resources"
                element={
                  <RoleGuard allow={['boss', 'ol', 'tl', 'apc', 'pctl', 'ipc']}>
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
                element={<RoleGuard allow="pctl"><PCTLIPCsPage /></RoleGuard>}
              />

              {/* Tasks — everyone authenticated (RLS enforces row visibility) */}
              <Route path="/tasks"         element={<TasksPage />} />
              {/* v1-port reports — separate routes per cadence, role-routed inside */}
              <Route
                path="/weekly-reports"
                element={
                  <RoleGuard allow={['boss','ol','tl','pctl','apc','ipc']}>
                    <WeeklyReportsRouter />
                  </RoleGuard>
                }
              />
              <Route
                path="/biweekly-reports"
                element={
                  <RoleGuard allow={['boss','ol','tl','pctl','apc','ipc']}>
                    <BiWeeklyReportsRouter />
                  </RoleGuard>
                }
              />
              <Route
                path="/monthly-reports"
                element={
                  <RoleGuard allow={['boss','ol','tl','pctl','apc','ipc']}>
                    <MonthlyReportsRouter />
                  </RoleGuard>
                }
              />
              <Route
                path="/gmv-max"
                element={
                  <RoleGuard allow={['boss','ol','tl','pctl','apc','ipc']}>
                    <GmvMaxReportingPage />
                  </RoleGuard>
                }
              />
              {/* Back-compat — old /reports* routes redirect to weekly */}
              <Route path="/reports"           element={<Navigate to="/weekly-reports" replace />} />
              <Route path="/reports/gmv-max"   element={<Navigate to="/gmv-max" replace />} />
              <Route path="/reports/new"       element={<Navigate to="/weekly-reports" replace />} />
              <Route path="/reports/:id"       element={<Navigate to="/weekly-reports" replace />} />
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
                  <RoleGuard allow={['boss', 'ol', 'tl', 'pctl', 'apc', 'ipc']}>
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
                  <RoleGuard allow={['boss', 'ol', 'tl', 'pctl', 'apc', 'ipc']}>
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
                  <RoleGuard allow={['boss', 'ol']}>
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
                element={<RoleGuard allow="boss"><TLsPage /></RoleGuard>}
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
                element={<RoleGuard allow="boss"><APCsPage /></RoleGuard>}
              />
              <Route
                path="/boss/manage/ipcs"
                element={<RoleGuard allow="boss"><IPCsPage /></RoleGuard>}
              />
              <Route
                path="/boss/manage/developers"
                element={<RoleGuard allow="boss"><DevelopersPage /></RoleGuard>}
              />

              {/* Resource Planner — Boss only (developer also allowed for debugging) */}
              <Route
                path="/boss/resource-planner"
                element={<RoleGuard allow={['boss', 'developer']}><ResourcePlannerPage /></RoleGuard>}
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
        </BrowserRouter>
          </ErrorReporterProvider>
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
