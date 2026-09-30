---
slug: agenda-tasks
title: Agenda Tasks
route: /agenda/tasks
roles: [boss, ol, tl, apc, pctl, ipc, ads_manager]
feature: agenda
last_reviewed: null
---
## What this page is for
Recurring tasks each APC reports on at the weekly agenda meeting. They are separate from the main Tasks page. Open it from **Agenda Meetings → Tasks**. The OL reviews these tasks during the live meeting.

## Who can use it
- **APC:** sees their own agenda tasks, adds tasks for themselves (**Add task**), changes status, and sets their **Reset schedule**.
- **Team Lead, Operation Lead, Boss:** see the tasks of the APCs they can see, assign tasks to an APC (**Assign task**), filter by APC, and change any task's status. Only OL/Boss (or the task's creator) can delete.
- **Paid Collab TL, IPC, Ads Manager:** these roles aren't treated as managers here. They get no APC filter, and they can change only tasks they created or were assigned.
  - **What they see:** everyone sees tasks assigned to them, tasks they created, and tasks on any brand they can view. A Paid Collab TL can view every brand, so they see every brand-linked agenda task. IPCs and Ads Managers see tasks on their own brands.
  - **Creating:** a Paid Collab TL can assign an agenda task to any APC, and so can an IPC with the "manage tasks" permission. Other IPCs and Ads Managers don't create agenda tasks.
  <!-- source: mig 175 agenda_tasks_select / _insert / _update / _delete; can_view_brand mig 316 (pctl all brands; ads_manager_brands); AgendaTaskModal.jsx:39-42 (APCs only); src/lib/tasksApi.js:241-251, :324-349 -->


## How to add a task (APC)
1. Click **Add task**.
2. Choose a **Brand** (optional — your active brands) and enter the **Task title** (required).
3. Optionally add **Details**, **Due date** and a **Link**.
4. Click **Add task**.

## How to assign a task to an APC (TL / OL / Boss)
1. Click **Assign task**. (If you've filtered to one APC, they are pre-selected.)
2. Pick the **APC**, then the **Brand** — the list shows that APC's active brands and picks it automatically if there's only one. "No specific brand" is allowed.
3. Enter the **Task title** and any details, due date or link.
4. Click **Assign task**. The APC is notified.

## How to update a task
1. Click **To Do**, **In Progress** or **Completed** on the task card.
2. Tick **Notify on change** first if you want the other person notified of the status change.
3. Delete with the bin icon (asks to confirm).

## How to set your reset schedule (APC)
1. Click **Reset schedule**.
2. Pick **Daily**, **Weekly** or **Monthly**, then the time (and day of week or day of month).
3. Click **Save**. The banner shows e.g. "Your agenda tasks reset weekly on Monday at 00:00".

## Rules & gotchas
- On your reset schedule, all your agenda tasks go back to **To Do** and roll to the next cycle.
- Overdue due dates show in red until the task is **Completed**.
- Use the status tabs (**All**, **To Do**, **In Progress**, **Completed**) and **Search tasks…** to filter.
- A TL can only assign to APCs who report to them.

## Related pages
- Ongoing Meetings (`/agenda/ongoing`) — where these tasks are presented and rated.
- Prior Meetings (`/agenda/prior`) — past task reviews.
- Tasks (`/tasks`) — the separate everyday task system.
