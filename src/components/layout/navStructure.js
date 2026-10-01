import {
  HomeIcon, ReportIcon, ChecklistIcon, ClockIcon, CheckIcon, UsersIcon, CalendarIcon,
  StoreIcon, VideoIcon, DiagramIcon, BugIcon, MessageIcon, TargetIcon,
} from '../common/Icon';
import { menuKey } from './menu';

// Round 4 navigation structure (F3/F4/F5), kept out of menu.js so the role
// menus themselves stay a plain list. Nothing here changes a menuKey, so
// saved layouts (Settings → Menu Layout) keep working.

// ── Approvals inbox (F3) ────────────────────────────────────────────
// Gates the Approvals menu item and bottom-bar tab. When false they're
// hidden and the approver tab falls back to Leave.
export const APPROVALS_PAGE_READY = true;
export const APPROVAL_ROLES = ['boss', 'ol', 'tl', 'pctl'];
export const APPROVALS_ITEM = { label: 'Approvals', icon: CheckIcon, to: '/approvals', badge: 'approvals' };

/** Adds the Approvals entry after Dashboard for approver roles (once ready). */
export function withApprovals(menu, role) {
  if (!APPROVALS_PAGE_READY || !APPROVAL_ROLES.includes(role)) return menu;
  if (menu.some((m) => m.to === '/approvals')) return menu;
  const i = menu.findIndex((m) => m.to === '/dashboard');
  const out = [...menu];
  out.splice(i >= 0 ? i + 1 : 0, 0, APPROVALS_ITEM);
  return out;
}

// ── Sectioned sidebar (F4) ──────────────────────────────────────────
// Ordered by how often each role needs the item. Keys are menuKey values
// (`to`, or `group:<Label>`). Entries a role has but a section doesn't list
// (Wurx Buddy, Video Reviews, anything added later) join the section of
// the entry before them in the role menu. Only used for the DEFAULT
// layout; a saved layout renders flat, exactly as the user arranged it.
const ME = ['/incentives', '/performance', '/me/compensation', 'group:Requests'];
export const SECTIONS = {
  apc: [
    { label: 'My day', keys: ['/dashboard', 'group:Reporting', '/tasks', '/attendance', '/video-reviews'] },
    { label: 'Brands', keys: ['/brands', '/analytics/brands', '/campaigns', '/product-campaigns'] },
    { label: 'Team & meetings', keys: ['group:Agenda Meetings', '/chat', '/broadcasts', '/reminders'] },
    { label: 'Me', keys: ME },
    { label: 'Help', keys: ['/kb', '/resources', '/changes', '/notifications', '/settings'] },
  ],
  tl: [
    { label: 'My day', keys: ['/dashboard', '/approvals', 'group:Reporting', '/tasks', '/attendance'] },
    { label: 'Team', keys: ['/tl/team', '/creator-library', 'group:Agenda Meetings', '/chat'] },
    { label: 'Brands', keys: ['/brands', '/analytics/brands', '/halo', '/campaigns', '/product-campaigns'] },
    { label: 'Me', keys: ME },
    { label: 'Help', keys: ['/kb', '/resources', '/broadcasts', '/reminders', '/changes', '/notifications', '/settings'] },
  ],
  ol: [
    { label: 'My day', keys: ['/dashboard', '/approvals', 'group:Reporting', 'group:Agenda Meetings', '/tasks', '/attendance'] },
    { label: 'Team', keys: ['/team-hierarchy', '/team-management', '/brand-switcher', '/creator-library', '/performance', '/incentives', '/achievements', '/chat'] },
    { label: 'Brands', keys: ['/brands', '/analytics/brands', '/halo', 'group:Paid Collab', '/campaigns', '/product-campaigns', '/client-access'] },
    { label: 'Company', keys: ['/broadcasts', '/reminders', '/kb', '/resources', '/changes', 'group:Requests', '/audit'] },
    { label: 'Me', keys: ['/me/compensation', '/notifications', '/settings'] },
  ],
  boss: [
    { label: 'My day', keys: ['/dashboard', '/approvals', 'group:Reporting', '/brands', '/analytics/brands'] },
    { label: 'Team', keys: ['group:Employees', '/team-hierarchy', '/team-management', '/brand-switcher', '/performance', '/incentives', '/achievements', '/attendance', '/holidays'] },
    { label: 'Brands & growth', keys: ['/creator-library', '/euka', '/halo', 'group:Paid Collab', '/campaigns', '/product-campaigns', '/client-access'] },
    { label: 'Company', keys: ['group:Agenda Meetings', '/tasks', '/broadcasts', '/reminders', '/kb', '/resources', '/changes', 'group:Requests', '/chat'] },
    { label: 'Admin', keys: ['/boss/resource-planner', '/audit', 'group:Development', '/notifications', '/settings'] },
  ],
  pctl: [
    { label: 'My day', keys: ['/dashboard', '/approvals', 'group:Paid Collab', '/creator-library', '/tasks', '/attendance'] },
    { label: 'Brands', keys: ['/analytics/brands', 'group:Reporting'] },
    { label: 'Me', keys: ME },
    { label: 'Team & help', keys: ['group:Agenda Meetings', '/chat', '/kb', '/changes', '/notifications', '/settings'] },
  ],
  ipc: [
    { label: 'My day', keys: ['/dashboard', '/creator-library', '/tasks', '/attendance'] },
    { label: 'Brands', keys: ['/brands', '/campaigns'] },
    { label: 'Me', keys: ME },
    { label: 'Team & help', keys: ['group:Agenda Meetings', '/chat', '/kb', '/changes', '/notifications', '/settings'] },
  ],
  ads_manager: [
    { label: 'My day', keys: ['/dashboard', '/gmv-max', '/brands', '/analytics/brands', '/tasks', '/attendance'] },
    { label: 'Me', keys: ['/incentives', '/me/compensation', 'group:Requests'] },
    { label: 'Team & help', keys: ['group:Agenda Meetings', '/chat', '/kb', '/notifications', '/settings'] },
  ],
};

/**
 * Split a role menu into [{ label, entries }]. Returns null when the role
 * has no sections (Developer) so the caller renders the flat list.
 */
export function sectionMenu(menu, role) {
  const defs = SECTIONS[role];
  if (!defs || !menu.length) return null;
  const sectionOf = new Map();
  defs.forEach((s, i) => s.keys.forEach((k) => sectionOf.set(k, i)));
  const buckets = defs.map(() => []);
  let prev = defs.length - 1;
  // Pass 1 assigns listed keys; unlisted entries follow their predecessor.
  const placed = menu.map((entry) => {
    const k = menuKey(entry);
    const idx = sectionOf.has(k) ? sectionOf.get(k) : prev;
    prev = idx;
    return { entry, idx, k };
  });
  // Inside a section, listed keys keep the section's order; extras stay
  // right after the entry they followed in the role menu.
  defs.forEach((s, i) => {
    const mine = placed.filter((p) => p.idx === i);
    const listed = s.keys.map((k) => mine.find((p) => p.k === k)).filter(Boolean);
    const out = [...listed];
    mine.forEach((p, j) => {
      if (listed.includes(p)) return;
      const before = mine.slice(0, j).reverse().find((q) => out.includes(q));
      out.splice(before ? out.indexOf(before) + 1 : out.length, 0, p);
    });
    buckets[i] = out.map((p) => p.entry);
  });
  return defs.map((s, i) => ({ label: s.label, entries: buckets[i] })).filter((s) => s.entries.length);
}

// ── Mobile bottom tab bar (F5) ──────────────────────────────────────
// 4 role tabs (+ More, which opens the drawer). Every `to` passes the
// role's RoleGuard in App.jsx.
const T = {
  today:     { key: 'today', label: 'Today', to: '/dashboard', icon: HomeIcon },
  reports:   { key: 'reports', label: 'Reports', to: '/weekly-reports', icon: ReportIcon, category: 'report' },
  tasks:     { key: 'tasks', label: 'Tasks', to: '/tasks', icon: ChecklistIcon, category: 'task' },
  attendance:{ key: 'attendance', label: 'Attendance', to: '/attendance', icon: ClockIcon },
  approvals: { key: 'approvals', label: 'Approvals', to: '/approvals', icon: CheckIcon, badge: 'approvals' },
  leave:     { key: 'leave', label: 'Leave', to: '/leave', icon: CalendarIcon, category: 'leave' },
  myTeam:    { key: 'team', label: 'My Team', to: '/tl/team', icon: UsersIcon },
  agenda:    { key: 'agenda', label: 'Agenda', to: '/agenda/upcoming', icon: CalendarIcon, category: 'agenda' },
  brands:    { key: 'brands', label: 'Brands', to: '/brands', icon: StoreIcon, category: 'brand' },
  creators:  { key: 'creators', label: 'Creators', to: '/paid-collab/creators', icon: UsersIcon },
  videos:    { key: 'videos', label: 'Videos', to: '/paid-collab/videos', icon: VideoIcon },
  library:   { key: 'library', label: 'Creators', to: '/creator-library', icon: UsersIcon, category: 'creator_library' },
  gmvMax:    { key: 'gmv', label: 'GMV Max', to: '/gmv-max', icon: TargetIcon },
  roadmap:   { key: 'roadmap', label: 'Roadmap', to: '/development/roadmap', icon: DiagramIcon, category: 'development' },
  devBugs:   { key: 'bugs', label: 'Bugs', to: '/development/bugs', icon: BugIcon },
  chat:      { key: 'chat', label: 'Chat', to: '/chat', icon: MessageIcon },
};
// Approver tab: the inbox, or Leave if the inbox is switched off.
const APPROVE = APPROVALS_PAGE_READY ? T.approvals : T.leave;

export const BOTTOM_TABS = {
  apc:         [T.today, T.reports, T.tasks, T.attendance],
  tl:          [T.today, APPROVE, T.reports, T.myTeam],
  ol:          [T.today, APPROVE, T.reports, T.agenda],
  boss:        [T.today, APPROVE, T.brands, T.reports],
  pctl:        [T.today, APPROVE, T.creators, T.videos],
  ipc:         [T.today, T.library, T.tasks, T.attendance],
  ads_manager: [T.today, T.gmvMax, T.brands, T.tasks],
  developer:   [T.roadmap, T.devBugs, T.attendance, T.chat],
};

export function bottomTabsFor(role) {
  return BOTTOM_TABS[role] || BOTTOM_TABS.apc;
}
