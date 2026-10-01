---
slug: team-hierarchy
title: Team Hierarchy
route: /team-hierarchy
roles: [boss, ol]
feature: admin
last_reviewed: null
---
## What this page is for
A visual org chart of the company (Boss → Operation Leads → Team Leads / Paid Collab TLs → APCs / IPCs) with the brands each person holds. You can click people and brands to move them. Open **Team Hierarchy** in the sidebar.

## Who can use it
Boss and Operation Leads. Both see the whole company and can make the moves described below.

## How to read the page
1. The top cards show **Headcount**, **Operations Leads**, **Team Leads** (TL and Paid Collab TL counts), **APCs / IPCs** (with average brands per APC) and **Brands Managed** (with unassigned and active counts).
2. Switch views with **Org Chart** or **Tree**. (**Matrix** only says "coming soon".)
3. Narrow down with **Search team or brand…**, **All roles** (TL, PCTL, APC, IPC) and **All teams** (one team lead's team).
4. Colours follow the legend: Boss, OL, TL, PCTL, APC, IPC.

## How to move an APC or IPC to a different lead
1. Click the person in the chart or tree. A **Team Member** panel opens on the right.
2. Under **Move to Team Lead** (or **Move to Paid Collab TL** for an IPC), pick the new lead.
3. Click **Reassign**. Their brands go with them; the page reloads.

## How to move a brand
1. Click a brand chip. A **Brand** panel opens showing its owner and how many APCs are assigned.
2. Choose:
   - **Move to TL** — pick a **New owner TL**. Only the owning lead changes; assigned APCs stay.
   - **Reassign APC** — pick a **New APC / IPC**. The brand moves to that person, and ownership moves to their Team Lead.
3. Click **Apply**.

## How to see a team lead's summary
Click the team lead's card to see their brands owned and team member count. To change anything, click the individual member or brand.

## Rules & gotchas
- APCs can only be moved under Team Leads, and IPCs only under Paid Collab TLs.
- **Reassign APC** on a brand only works if the brand already has someone assigned. For a brand with nobody assigned, use the Brand Switcher.
- The **All teams** filter only affects the Org Chart view, not the Tree.
- The subtitle mentions opening a profile, but clicking a person only opens the reassignment panel.
- **Moving a member** sends a "Team change" notification to the member, their old lead and their new lead. Their brands move with them only where they are the brand's only assignee; shared brands stay put.
- **Moving a brand** sends a "Brand moved" notification to the old and new TL, the newly assigned APC and any APCs previously on the brand.
- The person making the change isn't notified.
  <!-- source: mig 242 team_move_apc_to_tl (team.apc_moved; recipients member, new lead, old lead, minus actor); mig 114 team_move_ipc_to_pctl (wrapper); mig 158 team_move_brand (brand.moved; new TL, new APC, old TL, previous APCs, minus actor); HierarchyReassignPanel.jsx:281 -->

## Related pages
- Team Management (`/team-management`) — Brand Switcher with Assign/Swap and approvals, plus Reassign APC Lead.
- Employees (`/boss/manage/tls`) — Boss adds or edits the accounts shown here.
- Resource Planner (`/boss/resource-planner`) — capacity and headcount planning.
