import {
  HomeIcon, UsersIcon, ShieldIcon, StoreIcon, ChecklistIcon, SettingsIcon, BellIcon, ReportIcon,
  MegaphoneIcon, ClockIcon, BookmarkIcon, StarIcon, RefreshIcon, DiagramIcon,
  BugIcon, LightbulbIcon, ArrowLeftRightIcon, MessageIcon, CalendarIcon, PlayIcon,
} from '../common/Icon';

// Each role gets its own menu. Structure mirrors v1 layouts:
//   * Boss   — components/boss/BossLayout.js
//   * OL     — components/ol/OLLayout.js
//   * TL     — components/layout/Sidebar.js (the generic one)
//   * APC    — components/apc/ApcLayout.js
//   * IPC    — components/ipc/IPCLayout.js
//   * PCTL   — components/pctl/PCTLLayout.js
//   * dev    — components/dev/DevLayout.js (flat list, no groups)
//
// Items can carry a `category` matching notification categories so the
// sidebar shows an unread dot when there's something new in that area.
//
// Items with `children` render as a collapsible group in Sidebar.jsx.
// Items without children render as a top-level NavLink.

// --- Reusable single items -----------------------------------------
const TASKS_ITEM        = { label: 'Tasks',         icon: ChecklistIcon, to: '/tasks',         category: 'task' };
const BRAND_ANALYTICS   = { label: 'Brand analytics', icon: ReportIcon, to: '/analytics/brands' };
const EUKA_ANALYTICS_ITEM = { label: 'Euka Analytics', icon: StoreIcon,  to: '/euka' };
const VIDEO_REVIEWS_ITEM  = { label: 'Video Reviews', icon: PlayIcon, to: '/video-reviews' };
const BRAND_SWITCHES    = { label: 'Brand Switcher',  icon: RefreshIcon,  to: '/brand-switcher', category: 'brand' };
const AUDIT_LOG         = { label: 'Audit log',       icon: ShieldIcon, to: '/audit' };
const BRANDS_ITEM       = { label: 'Brands',        icon: StoreIcon,     to: '/brands',        category: 'brand' };
const PRODUCT_CAMPAIGNS = { label: 'Product Campaigns', icon: MegaphoneIcon, to: '/product-campaigns', category: 'product_campaign' };
const CAMPAIGNS         = { label: 'Campaigns', icon: MegaphoneIcon, to: '/campaigns', category: 'campaign' };
const MY_BRANDS         = { label: 'My Brands',     icon: StoreIcon,     to: '/brands',        category: 'brand' };
const CLIENT_ACCESS_ITEM  = { label: 'Client Access', icon: ShieldIcon, to: '/client-access' };
const TEAM_MGMT_ITEM      = { label: 'Team Management', icon: UsersIcon, to: '/team-management' };
const TEAM_HIERARCHY_ITEM = { label: 'Team Hierarchy', icon: DiagramIcon, to: '/team-hierarchy' };
const NOTIFS_ITEM   = { label: 'Notifications', icon: BellIcon,      to: '/notifications' };
const SETTINGS_ITEM = { label: 'Settings',      icon: SettingsIcon,  to: '/settings' };
const MY_COMPENSATION_ITEM = { label: 'My Compensation', icon: StarIcon, to: '/me/compensation', category: 'salary' };
const CHANGES_ITEM  = { label: 'Changes', icon: ArrowLeftRightIcon, to: '/changes', category: 'change' };
const ATTENDANCE_ITEM = { label: 'Attendance', icon: ClockIcon, to: '/attendance' };
const HOLIDAYS_ITEM   = { label: 'Holidays',   icon: CalendarIcon, to: '/holidays' };
const RESOURCES_ITEM  = { label: 'Resources',  icon: BookmarkIcon, to: '/resources' };
const PERFORMANCE_ITEM = { label: 'Performance', icon: StarIcon, to: '/performance' };
const INCENTIVES_ITEM = { label: 'Incentives',  icon: ReportIcon, to: '/incentives' };
const CHAT_ITEM       = { label: 'Chat',        icon: UsersIcon, to: '/chat' };
const KNOWLEDGE_ITEM  = { label: 'Knowledge Base', icon: BookmarkIcon, to: '/kb', category: 'knowledge_base' };
const REMINDERS_ITEM  = { label: 'Reminders', icon: BellIcon, to: '/reminders', category: 'reminder' };
const BROADCASTS_ITEM = { label: 'Broadcasts', icon: MegaphoneIcon, to: '/broadcasts' };
const DASHBOARD_ITEM  = { label: 'Dashboard', icon: HomeIcon, to: '/dashboard' };

// --- Reports collapsible group (v1: REPORTING_SUB) -----------------
const REPORTS_GROUP = {
  label: 'Reporting',
  icon: ReportIcon,
  category: 'report',
  children: [
    { label: 'Weekly Reports',    to: '/weekly-reports' },
    { label: 'Bi-Weekly Reports', to: '/biweekly-reports' },
    { label: 'Monthly Reports',   to: '/monthly-reports' },
    { label: 'GMV Max',           to: '/gmv-max' },
  ],
};

// --- Requests collapsible group (v1: REQUEST_SUB) ------------------
// Both /leave and /leave/approvals render the same LeaveRouter, which
// dispatches by role: Boss/Developer get the approval queue,
// everyone else gets My + Team tabs. So we only expose ONE entry —
// having both "My Leave" and "Leave Approvals" in the menu was a
// duplicate that caused user confusion (and showed the older buggy
// implementation if the user clicked the wrong one).
const REQUESTS_GROUP_BOSS = {
  label: 'Requests',
  icon: MessageIcon,
  children: [
    { label: 'Leave Requests', to: '/leave' },
    { label: 'Bug Reports',    to: '/bugs' },
    { label: 'Suggestions',    to: '/suggestions' },
  ],
};
const REQUESTS_GROUP_OL = {
  label: 'Requests',
  icon: MessageIcon,
  children: [
    { label: 'Leave',       to: '/leave' },
    { label: 'Bug Reports', to: '/bugs' },
    { label: 'Suggestions', to: '/suggestions' },
  ],
};
const REQUESTS_GROUP_APPROVER = {
  label: 'Requests',
  icon: MessageIcon,
  children: [
    { label: 'Leave',       to: '/leave' },
    { label: 'Bug Reports', to: '/bugs' },
    { label: 'Suggestions', to: '/suggestions' },
  ],
};
const REQUESTS_GROUP_APPLIER = {
  label: 'Requests',
  icon: MessageIcon,
  children: [
    { label: 'Leave',       to: '/leave' },
    { label: 'Bug Reports', to: '/bugs' },
    { label: 'Suggestions', to: '/suggestions' },
  ],
};

// --- Paid Collab group ---------------------------------------------
const PAID_COLLAB_BOSS_OL = {
  label: 'Paid Collab',
  icon: MegaphoneIcon,
  category: 'paid_collab',
  children: [
    { label: 'Brands',   to: '/paid-collab/brands' },
    { label: 'Creators', to: '/paid-collab/creators' },
    { label: 'Videos',   to: '/paid-collab/videos' },
  ],
};
const PAID_COLLAB_PCTL = {
  label: 'Paid Collab',
  icon: MegaphoneIcon,
  category: 'paid_collab',
  children: [
    { label: 'Dashboard', to: '/paid-collab/dashboard' },
    { label: 'Brands',    to: '/paid-collab/brands' },
    { label: 'Creators',  to: '/paid-collab/creators' },
    { label: 'Videos',    to: '/paid-collab/videos' },
    { label: 'IPCs',      to: '/pctl/ipcs' },
  ],
};

// --- Employees group (boss only, v1: MANAGE_SUB) -------------------
// Onboarding is omitted — no v2 page yet.
const EMPLOYEES_GROUP = {
  label: 'Employees',
  icon: UsersIcon,
  children: [
    { label: 'Affiliate TLs',   to: '/boss/manage/tls' },
    { label: 'Paid Collab TLs', to: '/boss/manage/pctls' },
    { label: 'Operation Leads', to: '/boss/manage/ols' },
    { label: 'APCs',            to: '/boss/manage/apcs' },
    { label: 'IPCs',            to: '/boss/manage/ipcs' },
    { label: 'Developers',      to: '/boss/manage/developers' },
    { label: 'Salaries',        to: '/boss/salaries' },
  ],
};

// --- Weekly Agenda Meetings group ----------------------------------
// Phase 1 submenus only (Prior/Ongoing/Upcoming Meetings come later).
// Settings is OL/Boss-managed, so the basic variant omits it for TL/APC.
const AGENDA_GROUP_FULL = {
  label: 'Agenda Meetings',
  icon: CalendarIcon,
  category: 'agenda',
  children: [
    { label: 'Upcoming Meetings', to: '/agenda/upcoming' },
    { label: 'Ongoing Meetings',  to: '/agenda/ongoing' },
    { label: 'Prior Meetings',    to: '/agenda/prior' },
    { label: 'Tasks',             to: '/agenda/tasks' },
    { label: 'Resources',         to: '/agenda/resources' },
    { label: 'Settings',          to: '/agenda/settings' },
  ],
};
const AGENDA_GROUP_BASIC = {
  label: 'Agenda Meetings',
  icon: CalendarIcon,
  category: 'agenda',
  children: [
    { label: 'Upcoming Meetings', to: '/agenda/upcoming' },
    { label: 'Ongoing Meetings',  to: '/agenda/ongoing' },
    { label: 'Prior Meetings',    to: '/agenda/prior' },
    { label: 'Tasks',             to: '/agenda/tasks' },
    { label: 'Resources',         to: '/agenda/resources' },
  ],
};

// ============================================================
// MENUS
// ============================================================
//
// Order chosen to roughly mirror v1 per-role ordering: dashboard
// first, then "work" (brands, campaigns, tasks), then management
// (employees/team), then operations (attendance/perf/incentives),
// then comms (chat/kb/reminders/broadcasts), then collapsible
// groups (Paid Collab, Reporting, Requests), then footer-style
// items (notifications/settings).

const ASSISTANT_ITEM = { label: 'Assistant', icon: MessageIcon, to: '/assistant' };

export const MENUS = {
  boss: [
    DASHBOARD_ITEM,
    EMPLOYEES_GROUP,
    BRANDS_ITEM,
    BRAND_ANALYTICS,
    EUKA_ANALYTICS_ITEM,
    VIDEO_REVIEWS_ITEM,
    BRAND_SWITCHES,
    CAMPAIGNS,
    PRODUCT_CAMPAIGNS,
    TASKS_ITEM,
    RESOURCES_ITEM,
    AGENDA_GROUP_FULL,
    { label: 'Resource Planner', icon: DiagramIcon, to: '/boss/resource-planner' },
    INCENTIVES_ITEM,
    ATTENDANCE_ITEM,
    HOLIDAYS_ITEM,
    PERFORMANCE_ITEM,
    BROADCASTS_ITEM,
    REMINDERS_ITEM,
    KNOWLEDGE_ITEM,
    CHANGES_ITEM,
    CLIENT_ACCESS_ITEM,
    TEAM_MGMT_ITEM,
    TEAM_HIERARCHY_ITEM,
    AUDIT_LOG,
    PAID_COLLAB_BOSS_OL,
    REPORTS_GROUP,
    REQUESTS_GROUP_BOSS,
    CHAT_ITEM,
    NOTIFS_ITEM,
    SETTINGS_ITEM,
  ],
  ol: [
    DASHBOARD_ITEM,
    BRANDS_ITEM,
    BRAND_ANALYTICS,
    BRAND_SWITCHES,
    CLIENT_ACCESS_ITEM,
    CAMPAIGNS,
    PRODUCT_CAMPAIGNS,
    TASKS_ITEM,
    RESOURCES_ITEM,
    AGENDA_GROUP_FULL,
    INCENTIVES_ITEM,
    ATTENDANCE_ITEM,
    PERFORMANCE_ITEM,
    BROADCASTS_ITEM,
    REMINDERS_ITEM,
    KNOWLEDGE_ITEM,
    CHANGES_ITEM,
    TEAM_MGMT_ITEM,
    TEAM_HIERARCHY_ITEM,
    AUDIT_LOG,
    PAID_COLLAB_BOSS_OL,
    REPORTS_GROUP,
    REQUESTS_GROUP_OL,
    CHAT_ITEM,
    MY_COMPENSATION_ITEM,
    NOTIFS_ITEM,
    SETTINGS_ITEM,
  ],
  tl: [
    DASHBOARD_ITEM,
    MY_BRANDS,
    { label: 'My team', icon: UsersIcon, to: '/tl/team' },
    CAMPAIGNS,
    PRODUCT_CAMPAIGNS,
    TASKS_ITEM,
    RESOURCES_ITEM,
    AGENDA_GROUP_BASIC,
    INCENTIVES_ITEM,
    ATTENDANCE_ITEM,
    PERFORMANCE_ITEM,
    BROADCASTS_ITEM,
    REMINDERS_ITEM,
    KNOWLEDGE_ITEM,
    CHANGES_ITEM,
    REPORTS_GROUP,
    REQUESTS_GROUP_APPROVER,
    CHAT_ITEM,
    MY_COMPENSATION_ITEM,
    NOTIFS_ITEM,
    SETTINGS_ITEM,
  ],
  pctl: [
    DASHBOARD_ITEM,
    TASKS_ITEM,
    INCENTIVES_ITEM,
    ATTENDANCE_ITEM,
    PERFORMANCE_ITEM,
    KNOWLEDGE_ITEM,
    CHANGES_ITEM,
    AGENDA_GROUP_BASIC,
    PAID_COLLAB_PCTL,
    REPORTS_GROUP,
    REQUESTS_GROUP_APPROVER,
    CHAT_ITEM,
    MY_COMPENSATION_ITEM,
    NOTIFS_ITEM,
    SETTINGS_ITEM,
  ],
  apc: [
    DASHBOARD_ITEM,
    MY_BRANDS,
    CAMPAIGNS,
    PRODUCT_CAMPAIGNS,
    TASKS_ITEM,
    RESOURCES_ITEM,
    AGENDA_GROUP_BASIC,
    INCENTIVES_ITEM,
    ATTENDANCE_ITEM,
    PERFORMANCE_ITEM,
    BROADCASTS_ITEM,
    REMINDERS_ITEM,
    KNOWLEDGE_ITEM,
    CHANGES_ITEM,
    REPORTS_GROUP,
    REQUESTS_GROUP_APPLIER,
    CHAT_ITEM,
    MY_COMPENSATION_ITEM,
    NOTIFS_ITEM,
    SETTINGS_ITEM,
  ],
  ipc: [
    DASHBOARD_ITEM,
    MY_BRANDS,
    CAMPAIGNS,
    TASKS_ITEM,
    INCENTIVES_ITEM,
    ATTENDANCE_ITEM,
    PERFORMANCE_ITEM,
    KNOWLEDGE_ITEM,
    CHANGES_ITEM,
    AGENDA_GROUP_BASIC,
    REQUESTS_GROUP_APPLIER,
    CHAT_ITEM,
    MY_COMPENSATION_ITEM,
    NOTIFS_ITEM,
    SETTINGS_ITEM,
  ],
  // Developer role is intentionally minimal — v1 parity (DevLayout.js).
  // Their job is to triage bugs + suggestions; no brands, no tasks.
  // Attendance + My Compensation are HR surfaces — the developer still
  // clocks in and gets paid like anyone else. DashboardRouter in
  // App.jsx redirects /dashboard to /bugs for this role so they land
  // on triage by default.
  developer: [
    { label: 'Bug Reports', icon: BugIcon, to: '/bugs', category: 'bug' },
    { label: 'Suggestions', icon: LightbulbIcon, to: '/suggestions', category: 'suggestion' },
    ATTENDANCE_ITEM,
    { label: 'Leave', icon: CalendarIcon, to: '/leave', category: 'leave' },
    MY_COMPENSATION_ITEM,
    NOTIFS_ITEM,
    SETTINGS_ITEM,
  ],
};

export function getMenuForRole(role, opts = {}) {
  const base = MENUS[role] || MENUS.apc;
  const out = [...base];
  // AI Assistant is BOSS-ONLY during the test phase (server also enforces this
  // in the ai-chat function). Widen this check when launching to more roles.
  if (role === 'boss') {
    const i = out.indexOf(NOTIFS_ITEM);
    out.splice(i >= 0 ? i : out.length, 0, ASSISTANT_ITEM);
  }
  // Video Reviews is shown to OL / TL / APC ONLY when they actually have a
  // brand on Euka (Boss has it statically above). The Sidebar computes
  // hasEukaBrand from the user's Euka-linked brands. The edge function also
  // enforces per-brand access, so this is UX, not the security boundary.
  if (opts.hasEukaBrand && (role === 'ol' || role === 'tl' || role === 'apc')) {
    const i = out.indexOf(NOTIFS_ITEM);
    out.splice(i >= 0 ? i : out.length, 0, VIDEO_REVIEWS_ITEM);
  }
  return out;
}
