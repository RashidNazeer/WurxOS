import { lazyWithRetry as lazy } from '../lib/lazyWithRetry';

// Route registry. Every lazy page lives here so the shell can warm a
// route's chunk before the click (S3): lazyWithRetry exposes .preload on
// each component, and PRELOAD_BY_PATH maps the menu/tab paths to them.

// Every page is code-split via React.lazy. Each becomes its own
// chunk that downloads only when its route is hit. This shrinks the
// initial bundle from ~1.6MB to a few hundred KB and makes the first
// paint dramatically faster.
// /dashboard. The Today pages shipped, so this is the real dashboard for every
// role — the old Boss/RoleDashboard stubs it replaced have been deleted.
export const TodayRouter           = lazy(() => import('../pages/today/TodayRouter'));
// /r/:reportId. Day-1 stand-in; B swaps in ReportLinkResolver (F2).
export const ReportLinkResolver    = lazy(() => import('./ReportLinkStub'));
export const ApprovalsPage         = lazy(() => import('../pages/approvals/ApprovalsPage'));
export const TLsPage               = lazy(() => import('../pages/boss/manage/TLsPage'));
export const PCTLsPage             = lazy(() => import('../pages/boss/manage/PCTLsPage'));
export const OLsPage               = lazy(() => import('../pages/boss/manage/OLsPage'));
export const APCsPage              = lazy(() => import('../pages/boss/manage/APCsPage'));
export const IPCsPage              = lazy(() => import('../pages/boss/manage/IPCsPage'));
export const AdsManagersPage       = lazy(() => import('../pages/boss/manage/AdsManagersPage'));
export const DevelopersPage        = lazy(() => import('../pages/boss/manage/DevelopersPage'));
export const BrandsPage            = lazy(() => import('../pages/brands/BrandsPage'));
export const BrandDetailPage       = lazy(() => import('../pages/brands/BrandDetailPage'));
export const TasksPage             = lazy(() => import('../pages/tasks/TasksPage'));
export const PaidCollabBrandsPage  = lazy(() => import('../pages/paidCollab/BrandsPage'));
export const PaidCollabCreatorsPage= lazy(() => import('../pages/paidCollab/CreatorsPage'));
export const PaidCollabVideosPage  = lazy(() => import('../pages/paidCollab/VideosPage'));
export const PaidCollabDashboardPage = lazy(() => import('../pages/paidCollab/DashboardPage'));
export const PCTLIPCsPage          = lazy(() => import('../pages/pctl/IPCsPage'));
export const ReportPortalPage      = lazy(() => import('../pages/portal/ReportPortalPage'));
export const HaloPortalPage        = lazy(() => import('../pages/portal/HaloPortalPage'));
export const HaloV2PortalPage      = lazy(() => import('../pages/portal/HaloV2PortalPage'));
export const ClientPortalPage      = lazy(() => import('../pages/portal/ClientPortalPage'));
export const GmvMaxReportingPage   = lazy(() => import('../components/reporting/GmvMaxReportingPage'));
export const WeeklyReportsRouter   = lazy(() => import('../components/reporting/WeeklyReportsRouter'));
export const BiWeeklyReportsRouter = lazy(() => import('../components/reporting/BiWeeklyReportsRouter'));
export const MonthlyReportsRouter  = lazy(() => import('../components/reporting/MonthlyReportsRouter'));
export const ClientAccessPage      = lazy(() => import('../pages/clientAccess/ClientAccessPage'));
// v1 verbatim port — tabbed Brand Switcher + Reassign APC Lead. Replaces
// v2's bespoke single-roster page.
export const TeamManagementPage    = lazy(() => import('../components/teamManagement/TeamManagementPage'));
export const TeamHierarchyPage     = lazy(() => import('../pages/teamManagement/TeamHierarchyPage'));
export const HolidaysPage          = lazy(() => import('../pages/holidays/HolidaysPage'));
export const LeavePage             = lazy(() => import('../components/leave/LeaveRouter'));
export const LeaveApprovalsPage    = lazy(() => import('../components/leave/LeaveRouter'));
export const BrandAnalyticsPage    = lazy(() => import('../pages/analytics/BrandAnalyticsPage'));
// Replaced the v2-original page with the v1-port that lives under
// components/attendance. Keeps the /attendance route + menu link
// pointing at the new file.
export const AttendancePage        = lazy(() => import('../components/attendance/AttendancePage'));
// v1 verbatim port replaces the v2-original ResourcesPage. The v1 file
// (components/resources/AllResourcesPage.jsx) uses Bootstrap-styled
// brand cards + general visibility model (private/user/group/office).
export const ResourcesPage         = lazy(() => import('../components/resources/AllResourcesPage'));
// Replaced the v2-original page with the v1-port that lives under
// components/performance. Keeps the /performance route + menu link
// pointing at the new file.
export const PerformancePage       = lazy(() => import('../components/performance/PerformancePage'));
export const PerformanceSimulatorPage = lazy(() => import('../components/performance/PerformanceSimulatorPage'));
// Replaced the v2-original single-page Incentives with v1-style
// per-role pages, dispatched by IncentivesRouter. The plan editor
// (IncentiveForm) is shared between Boss and OL via /incentives/edit/:userId.
export const IncentivesPage        = lazy(() => import('../components/incentives/IncentivesRouter'));
export const AchievementsPage      = lazy(() => import('../pages/achievements/AchievementsPage'));
export const CreatorLibraryPage    = lazy(() => import('../pages/creators/CreatorLibraryPage'));
export const IncentivePlanEditorPage = lazy(() => import('../components/incentives/IncentiveForm'));
export const BroadcastsPage        = lazy(() => import('../pages/broadcasts/BroadcastsPage'));
// Replaced v2-original campaigns pages with v1 verbatim ports under
// components/campaigns. Routes + menu links unchanged.
export const ProductCampaignsPage  = lazy(() => import('../components/campaigns/ProductCampaignsPage'));
export const CampaignTrackerPage   = lazy(() => import('../components/campaigns/CampaignTrackerPage'));
export const RemindersPage         = lazy(() => import('../pages/reminders/RemindersPage'));
export const KnowledgeBasePage     = lazy(() => import('../components/knowledge/KnowledgeBaseRouter'));
export const ChatPage              = lazy(() => import('../pages/chat/ChatPage'));
export const BrandSwitcherPage     = lazy(() => import('../pages/brands/BrandSwitcherPage'));
export const TLTeamPage            = lazy(() => import('../pages/tl/TeamPage'));
export const AuditPage             = lazy(() => import('../pages/audit/AuditPage'));
export const SettingsPage          = lazy(() => import('../pages/settings/SettingsPage'));
export const NotificationsPage     = lazy(() => import('../pages/notifications/NotificationsPage'));
export const BuddyPage             = lazy(() => import('../pages/buddy/BuddyPage'));
export const ResourcePlannerPage   = lazy(() => import('../pages/resourcePlanner/ResourcePlannerPage'));
export const BossSalariesPage      = lazy(() => import('../pages/boss/salaries/BossSalariesPage'));
export const MyCompensationPage    = lazy(() => import('../pages/me/MyCompensationPage'));
export const BugsPage              = lazy(() => import('../pages/bugs/BugsPage'));
export const SuggestionsPage       = lazy(() => import('../pages/suggestions/SuggestionsPage'));
// v1 verbatim port — boss gets BossChangeManagementPage, others get
// the submitter-side ChangeManagementPage. Routed via the role router.
export const ChangesPage           = lazy(() => import('../components/changes/ChangeManagementRouter'));
export const AgendaTasksPage       = lazy(() => import('../pages/agenda/AgendaTasksPage'));
export const AgendaResourcesPage   = lazy(() => import('../pages/agenda/AgendaResourcesPage'));
export const AgendaSettingsPage    = lazy(() => import('../pages/agenda/AgendaSettingsPage'));
export const AgendaUpcomingPage    = lazy(() => import('../pages/agenda/AgendaUpcomingPage'));
export const AgendaOngoingPage     = lazy(() => import('../pages/agenda/AgendaOngoingPage'));
export const AgendaPriorPage       = lazy(() => import('../pages/agenda/AgendaPriorPage'));
export const AgendaCheckpointPage  = lazy(() => import('../pages/agenda/AgendaCheckpointPage'));
export const EukaAnalyticsPage     = lazy(() => import('../pages/euka/EukaAnalyticsPage'));
export const HaloV2Page            = lazy(() => import('../pages/boss/HaloV2Page'));
export const VideoReviewsPage      = lazy(() => import('../pages/video-reviews/VideoReviewsPage'));
export const TikTokCallbackPage    = lazy(() => import('../pages/oauth/TikTokCallbackPage'));
export const DevelopmentLayout     = lazy(() => import('../pages/development/DevelopmentLayout'));
const devPage = (name) => lazy(() => import('../pages/development/pages').then((m) => ({ default: m[name] })));
export const DevRoadmapPage   = devPage('RoadmapPage');
export const DevOverviewPage  = devPage('OverviewPage');
export const DevProjectsPage  = devPage('ProjectsPage');
export const DevProjectPage   = devPage('ProjectPage');
export const DevTaskListPage  = devPage('AllTasksPage');
export const DevBugsPage      = devPage('BugsPage');
export const DevTeamPage      = devPage('TeamPage');
export const DevActivityPage  = devPage('ActivityPage');

// Paths the sidebar and bottom bar link to → the page to warm.
export const PRELOAD_BY_PATH = {
  '/dashboard': TodayRouter,
  '/approvals': ApprovalsPage,
  '/brands': BrandsPage,
  '/tasks': TasksPage,
  '/weekly-reports': WeeklyReportsRouter,
  '/biweekly-reports': BiWeeklyReportsRouter,
  '/monthly-reports': MonthlyReportsRouter,
  '/gmv-max': GmvMaxReportingPage,
  '/attendance': AttendancePage,
  '/leave': LeavePage,
  '/performance': PerformancePage,
  '/incentives': IncentivesPage,
  '/creator-library': CreatorLibraryPage,
  '/chat': ChatPage,
  '/kb': KnowledgeBasePage,
  '/resources': ResourcesPage,
  '/notifications': NotificationsPage,
  '/settings': SettingsPage,
  '/analytics/brands': BrandAnalyticsPage,
  '/campaigns': CampaignTrackerPage,
  '/product-campaigns': ProductCampaignsPage,
  '/tl/team': TLTeamPage,
  '/team-hierarchy': TeamHierarchyPage,
  '/team-management': TeamManagementPage,
  '/brand-switcher': BrandSwitcherPage,
  '/agenda/upcoming': AgendaUpcomingPage,
  '/agenda/ongoing': AgendaOngoingPage,
  '/agenda/checkpoint': AgendaCheckpointPage,
  '/paid-collab/creators': PaidCollabCreatorsPage,
  '/paid-collab/videos': PaidCollabVideosPage,
  '/paid-collab/brands': PaidCollabBrandsPage,
  '/me/compensation': MyCompensationPage,
  '/development/roadmap': DevRoadmapPage,
  '/development/bugs': DevBugsPage,
};

const done = new Set();
/** Start downloading the chunk behind a menu path (no-op if unknown or already warm). */
export function preloadPath(to) {
  const path = String(to || '').split('?')[0];
  const page = PRELOAD_BY_PATH[path];
  if (!page?.preload || done.has(path)) return;
  done.add(path);
  page.preload().catch(() => { done.delete(path); });
}

/**
 * Warm a list of paths when the browser is idle, unless the user is on a
 * data-saver or 2G connection.
 */
export function preloadWhenIdle(paths) {
  const c = typeof navigator !== 'undefined' ? navigator.connection : null;
  if (c?.saveData || /(^|-)2g$/.test(c?.effectiveType || '')) return;
  const run = () => paths.forEach(preloadPath);
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(run, { timeout: 4000 });
  else setTimeout(run, 1500);
}
