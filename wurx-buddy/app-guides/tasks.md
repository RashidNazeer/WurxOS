---
slug: tasks
title: Tasks
route: /tasks
roles: [boss, ol, tl, pctl, apc, ipc, developer, ads_manager]
feature: agenda
last_reviewed: null
---
## What this page is for
Your to-do list: tasks assigned to you, tasks you gave to others, and personal to-dos. Open it from **Tasks** in the sidebar.

## Who can use it
Every signed-in role can open it (Developers have no menu entry for it but can open the link).
- **Boss, OL, Developer, PCTL**: can create tasks with or without a brand and assign them to any active user. When a brand is picked, the "Assign to" list narrows to that brand's TL, the people assigned to it, and PCTLs on it.
- **TL**: can pick brands they own and assign to APCs who report to them. TLs also get a **Group task** button.
- **APC**: can create personal tasks for yourself, with no brand. With the "manage tasks" permission you can also create brand tasks.
- **IPC**: self-assign only, unless they have the "manage tasks" permission. With it, they can pick several APCs at once, and one task is created per APC.
- **Ads Manager**: can create personal tasks (no brand, assigned to yourself). Keep **Personal** switched on.
<!-- source: mig 022 can_create_tasks (ads_manager → false; apc/ipc → canManageTasks) and tasks_insert (personal = brand_id is null and assignee = self, otherwise can_create_tasks) -->

Tabs: **All**, **Assigned to me**, **Personal**, **Inactive**, and **Assigned by me** (only for roles that can assign work to others, i.e. Boss, OL, TL, PCTL, Developer, and APC/IPC with the "manage tasks" permission).

## How to add a task
1. Click **Add task**.
2. To make a private to-do, switch on **Personal task** ("Only you will see it — no brand, self-assigned.").
3. Otherwise pick a **Brand (optional)** and, if shown, an assignee in **Assign to** (IPCs with the permission use **Assign to APCs** and tick several people).
4. Fill **Title** (required), **Description**, **Category** (General, Daily, Weekly, Monthly) and **Priority** (Low, Medium, High).
5. For General tasks you can set a **Due date**; recurring categories have no due date and show a "Resets ..." hint instead. Add a **Link** if useful.
6. Tick **Notify <name>** if you want the other person to get an in-app and push notification (off by default).
7. Click **Create task**.

## How to create a group task (TL)
1. Click **Group task**.
2. Tick the brands (only your brands that have APCs assigned appear); use **Select all** or **Clear**.
3. The preview shows how many tasks will be created (one per brand per assigned APC).
4. Fill the task fields and click **Create N tasks**.

## How to update a task's status
- Click the round check button to cycle To do → In progress → Done (this never sends a notification).
- Or click the status pill and choose **To do**, **In progress** or **Done**; tick the **Notify ...** box in that menu first if you want the other person pinged.
- In **Kanban** view, drag the card to another column.
You can change status if you are the assignee, the creator, the brand's TL, or Boss/OL/Developer.

## How to edit, comment on or delete tasks
- Click a task's title to open its details, including **Attachments** (upload files up to 10 MB) and **Comments**.
- **Edit** appears for the creator, the brand's TL, and Boss/OL/Developer. The brand cannot be changed after creation.
- To delete or bulk-change status, tick the checkboxes on the rows you can edit, then use **Mark to-do**, **Mark in progress**, **Mark done** or **Delete** in the bar that appears. There is no single-task delete button.

## Rules & gotchas
- Tasks on an inactive brand are **Frozen**: they only appear in the **Inactive** tab and cannot change status, be edited or deleted until the brand is reactivated. Bulk actions skip them.
- Daily/Weekly/Monthly tasks reset automatically on the assignee's reset schedule.
- A **Coverage** chip means the task was temporarily reassigned because its owner is on leave.
- Filters (Assignee, Brand, Priority, Category) only appear when there is more than one option; **Due** filters Overdue, Due today, Due this week or No due date.
- You can delete only your own comments and attachments (Boss can delete any).

## Related pages
- Agenda Tasks (`/agenda/tasks`) — action items from agenda meetings.
- Notifications (`/notifications`) — where task notifications arrive.
- Settings (`/settings`) — personal preferences, including notification settings.
