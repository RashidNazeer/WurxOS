---
slug: dashboard
title: Dashboard
route: /dashboard
roles: [boss, ol, tl, pctl, apc, ipc, ads_manager]
feature: analytics
last_reviewed: null
---
## What this page is for
The home page you land on after signing in. It gives a quick snapshot of your day and links to the pages you use most. Open it from the sidebar with **Dashboard**. Going to the app's root address also brings you here.

## Who can use it
- **Boss** sees a team overview. It is headed "Welcome, <name>".
- **OL, TL, PCTL, APC, IPC and Ads Manager** see a personal snapshot. It is headed "Good morning / Good afternoon / Good evening, <name>".
- **Developer** never sees a dashboard. Opening Dashboard sends a developer straight to Development → Roadmap.

## How to read the Boss dashboard
1. The top cards count people by role: **Operation Leads**, **Team Leads**, **Paid Collab TLs**, **APCs**, **IPCs** and **Developers**. Click a card to open that employee list.
2. The **Build your team** card has an **Add a team member** button. It opens the Operation Leads list, where you can create users.
3. **Maintenance → Repair Week Labels**: click **Run repair** and confirm. This renumbers the week labels on every weekly report. It only changes labels, and it is safe to run any time. When it finishes, it shows how many reports it relabelled across how many brands.

## How to read your snapshot (everyone else)
1. The stat tiles along the top:
   - **My open tasks** shows how many are overdue or due today. It opens Tasks.
   - **Unread notifications** opens Notifications.
   - **My pending leaves** opens Leave.
   - **Leaves to approve** is shown to OL, TL and PCTL only. It opens the leave page.
   - OLs also get **Active brands**, **Active users** and **Switch requests**.
2. The panels below:
   - **Tasks**: up to six of your open tasks with their due dates. **Open tasks →** goes to Tasks.
   - **Your brands**: active brands you can see. Shown to OL, TL, PCTL, APC and IPC. The link is **Manage →**.
   - **Reports in flight**: draft, submitted and rejected weekly or bi-weekly reports. Shown to OL, TL and APC. The link is **All reports →**.
   - **Your IPCs** and **Paid Collab**: PCTL only. They link to the IPCs page and to Paid Collab Brands.
3. On your work anniversary, a **Congratulations on N years** banner appears at the top. Close it with its button and it won't come back for that year.

## Rules & gotchas
- **Leaves to approve** counts every pending request you can see that you didn't submit. That includes requests that are still at another approver's stage.
- For an OL, the **Active users** tile opens a Boss-only page, so it bounces back to the Dashboard.
- For a PCTL, the **Manage →** link on **Your brands** opens a page PCTLs can't open, so it also bounces back to the Dashboard.
- The **Your brands** panel shows at most 8 brands, and each panel shows only what you're allowed to see.
- **Ads Manager** gets only the tasks, notifications and leave tiles and the Tasks panel. No brand or report panels are shown.

## Related pages
- Tasks (`/tasks`): your full task list.
- Leave (`/leave`): submit leave or approve your team's.
- Notifications (`/notifications`): everything behind the unread count.
