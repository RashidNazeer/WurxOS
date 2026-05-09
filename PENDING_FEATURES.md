# Pending Features

Tracking work that's been discussed but not yet built. New items go at the top.

---

## Mobile responsiveness

The app is desktop-first. The sidebar already collapses to a slide-in drawer below 860px (see `@media (max-width: 860px)` in [src/styles/shell.css](src/styles/shell.css)), but the rest of the UI wasn't designed for narrow widths. Phased plan, in priority order:

### Wave 1 — Shell & critical paths (1-2 days)
- Add a hamburger / drawer-toggle button to the **Topbar** that flips `data-mobile-open` on `.shell` (currently no way to open the sidebar on mobile)
- Add a backdrop overlay (`.shell-mobile-overlay` is partially styled — needs the React render + click-to-close handler)
- Make the **Topbar** stack the title/subtitle/actions on narrow widths
- Make **Dashboard** cards (BossDashboard / RoleDashboard) collapse from a multi-column grid to a single column under 720px
- Make **Login** / **Signup** forms breathe: bigger tap targets, full-width inputs, padding tweaks
- Test on a 360px viewport (iPhone SE territory)

### Wave 2 — List pages & tables
The hardest piece. These pages all use multi-column flex/grid layouts that don't fit phones:
- Brands list (BrandsPage) — many columns: name, owner, tier, status, actions
- Tasks list (TasksPage) — title, assignee, brand, status, due date
- Reports list (ReportsPage)
- Manage Users pages (TLs, PCTLs, OLs, APCs, IPCs, Developers)
- Audit log

Approach: convert each `.wx-list-row` to a stacked card layout under ~720px. Hide secondary columns; show key info (name + status + 1-2 action buttons) and put the rest in an expand-on-tap detail.

### Wave 3 — Modals & forms
- CreateUserModal, EditUserModal, BrandForm, CreateTaskModal, ReportPage editor — all assume desktop modal sizing
- Make modals go full-screen below 720px (already a common pattern in `wx-modal`; needs media query)
- Bigger touch targets (min 44×44px)
- Stack two-column form rows into one column

### Wave 4 — Edge cases
- **Chat**: the channels-rail + active-thread two-pane layout doesn't fit phones. Needs to become single-pane with back-navigation between rail and thread.
- **Charts** (Recharts on Dashboard, BrandAnalyticsPage, PerformancePage): need explicit mobile breakpoints — currently chart widths overflow horizontally on phones.
- **Settings**: the two-column nav-panel + content layout works down to ~720px but fails on phones. Could collapse the nav to a top-row dropdown.
- **Brand detail page**: same two-column issue as Settings.
- **Resource Planner**: tab layout + dense data — probably needs a separate mobile-optimized read-only view, since editing on a phone is rare.

### Out of scope (won't do)
- Native mobile app (iOS/Android) — separate effort
- Touch gestures beyond standard tap (swipe-to-delete, pull-to-refresh) — over-engineering for this app

---

## Other pending work

_(Add new items here as they come up.)_
