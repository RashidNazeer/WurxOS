---
slug: team-management
title: Team Management
route: /team-management
roles: [boss, ol]
feature: admin
last_reviewed: null
---
## What this page is for
Move brands between APCs and move APCs to a different Team Lead, from one place. Open **Team Management** in the sidebar. It has two tabs: **Brand Switcher** and **Reassign APC Lead**.

## Who can use it
- **Boss** — all changes apply straight away; approves or rejects requests in the Brand Switcher tab.
- **Operation Leads** — can apply brand moves directly or send them to the Boss as a request, and can reassign APCs.

## How to give a brand to a different APC (Brand Switcher tab)
1. On **All brands**, search by brand, client, APC or TL and click **Reassign APC** on the brand's row.
2. Choose what should happen:
   - **Assign only** — only this brand moves; the new APC keeps all their brands.
   - **Swap portfolios** — the two APCs exchange their whole books of brands.
3. (OL only) choose **Apply directly** or **Request from Boss**.
4. Search for and click the new APC. The window previews each person's brands before and after.
5. Add a **Note** (or, for a request, a **Reason for Boss**). Tick **Notify the new APC and their Team Lead** if you want them told.
6. Click **Confirm assign** / **Confirm swap**, or **Submit assign request** / **Submit swap request**.

## How to handle switch requests (Brand Switcher tab)
1. Open the **Pending** tab.
2. Boss: click **Approve** (a confirmation explains whether it is an Assign or a Swap) or **Reject** (you can add a rejection note).
3. The person who sent a request can **Cancel** it while it is pending.
4. Decided requests are in **History**.

## How to move an APC to a different Team Lead (Reassign APC Lead tab)
1. Under **1. Pick APC**, search by name, email or current TL and click the APC. Each entry shows their role, brand count and current TL.
2. Under **2. Pick new Team Lead**, click the new lead. Their current lead is greyed out.
3. Check the summary bar ("… will move from … to …") and click **Reassign**.
4. In **Confirm reassignment**, click **Confirm**. A green message confirms the move.

## Rules & gotchas
- A swap moves two people's entire portfolios and removes anyone else assigned to the moved brands (IPCs, temporary cover). Use **Assign only** unless you really mean a swap.
- When Boss approves a swap request, it is applied to the assignments as they are at approval time, not when the request was made.
- Moving an APC to a new Team Lead takes their brands with them only where the APC is the brand's only assignee. Shared brands stay with their current TL; move those separately.
- The APC list also includes IPCs; for an IPC only Paid Collab Team Leads are offered as the new lead, and for an APC only Team Leads.
- After you confirm, the APC, their old TL and their new TL each get a "Team change" notification, as the confirmation says. You aren't notified if you're one of them, and if the APC had no TL before, there's no old-TL notification.
  <!-- source: ReassignApcLeadTab.jsx:273 (confirmation text); src/utils/teamManagementService.js:65-72 → team_move_apc_to_tl (mig 242: emit_notification to apc, new TL, old TL, skipping nulls and caller; brands re-owned only where sole assignee) -->

## Related pages
- Brand Switcher (`/brand-switcher`) — the same Brand Switcher as a standalone page.
- Team Hierarchy (`/team-hierarchy`) — org chart where you can also move members and brands.
- Employees (`/boss/manage/apcs`) — Boss can change an APC's "Reports to" while editing the account.
