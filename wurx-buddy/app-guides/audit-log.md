---
slug: audit-log
title: Audit log
route: /audit
roles: [boss, ol]
feature: admin
last_reviewed: null
---
## What this page is for
A list of the most recent 250 recorded changes (who changed what, and when) to brands, tasks, reports, leave requests and brand switch requests. Open **Audit log** in the sidebar.

## Who can use it
- **Boss** — sees the log entries.
- **Operation Leads** — can open the page (it is in their menu), but the log is currently readable by the Boss only, so it shows "Nothing logged" for them.

## How to read the log
Each row shows:
- **When** — date and time of the change.
- **Actor** — the person who made it and their role ("System" if no person is recorded).
- **Action** — insert (created), update (changed) or delete.
- **Summary** — the item's title, brand name or status; for updates, the names of up to three fields that changed (e.g. "changed: status, owner_id (+2)").
- **Entity** — the type of item.

## How to find a change
1. Pick an item type from **All entities**: brands, tasks, reports, leave_requests or brand_switch_requests.
2. Pick **All actions**, insert, update or delete.
3. Type in **Search actor or payload…** to match the person's name or any value in the before/after data (for example a brand name).
4. Click the refresh icon at the top right to load the latest entries.

## Rules & gotchas
- Only the latest 250 entries for the chosen entity/action are loaded; search only looks inside those 250. Narrow with the drop-downs to reach older entries of one type.
- Field names in the summary are internal names (e.g. owner_id), not the labels you see elsewhere in the app.
- The log is read-only; nothing can be undone from here.

## Related pages
- Brand Switcher (`/brand-switcher`) — the switch requests that appear here.
- Team Management (`/team-management`) — brand and APC moves.
