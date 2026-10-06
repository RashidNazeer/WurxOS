---
slug: development
title: Development
route: /development/roadmap
roles: [boss, developer]
feature: development
last_reviewed: null
---
## What this page is for
The product workspace where the Boss and the developers plan and track work on the company's software projects: projects, releases, tasks and bugs. Open it from the **Development** menu group: **Roadmap**, **Overview**, **Projects**, **All tasks**, **Bugs**, **Team**, **Activity**. Developers land on the Roadmap when they open the Dashboard.

## Who can use it
- **Boss** changes everything: adds and edits projects and releases, assigns tasks to anyone, and is the only one who can delete a task.
- **Developer** sees everything and can comment on any task, but can only change tasks assigned to them. A task a developer creates is assigned to them automatically.
- Nobody else can open Development.

## How to read the Roadmap
1. Pick a project from the project tabs at the top (each shows open or blocked task counts).
2. Pick a release from the switcher in the **Release map** bar (Current, Planned, Shipped, or **Unscheduled work**). It opens on the current release.
3. Tasks sit in branches: **Needs a decision** (Blocked), **Moving forward** (In progress, In review), **Up next** (To do) and **Completed** (hidden until you click **Completed**).
4. Use **Blockers only** to see just blocked work, and the zoom buttons at the bottom to resize.
5. Drag a card to another branch to change its status, or change priority, status, owner and due date right on the card.

## How to create a task or report a bug
1. Click **New task** (Boss: **Assign task**), **Report a bug**, **Add task**, or the **+** on a roadmap branch. Press **/** anywhere in Development to find an existing task first.
2. Fill in **Title**, **Type** (Feature / Bug), **Project**, **Release** (or Unscheduled), **Priority** (Urgent, High, Normal, Low), **Due date** and **Status**. The Boss also picks **Assign to**.
3. Add a **Description** and files (pick, or paste a screenshot; up to 25 MB each).
4. Click **Create task** / **Report bug**. The task gets a WRX number and its panel opens.

## How to work on a task
1. Click a task to open its panel.
2. Change **Status**, **Priority**, **Due date**, **Type**, **Project** or **Release**. Moving it to **Blocked** asks "What's blocking…?" — enter a reason and click **Mark as blocked**.
3. Use **Add a description** / **Edit**, add checklist steps ("Add a step and press Enter"), and **Add files**.
4. Post in **Comments**; type **@** to mention someone, attach files with the paperclip, press Ctrl + Enter to send. **Reply**, **Edit** and **Delete** sit under each comment.
5. The **History** tab lists every change. The link icon copies a shareable link.

## How to manage projects and releases (Boss)
1. **Projects → New project**: Name, Short name (used in the link), Letter mark, Colour, Stage (Live / Pre-launch), Health, Description, Lead, Members. Click **Add project**.
2. On a project page, **Edit project** changes these or archives / restores the project.
3. **Plan a release** (Projects page, project page or Roadmap): Project, Name, Target date, Status (Planned / Current / Shipped), What ships in it.
4. From a release's actions menu: **Edit release**, **Make it the current release**, **Mark as shipped**, **Reopen as current**. **Delete release** is inside Edit release.

## How to use the other pages
- **Overview**: counts (Active projects, In progress, Needs attention, Completed), project cards, Team tasks and Recent activity; **Review blockers** opens blocked tasks.
- **Projects**: active / archived projects and a release timeline in two-week windows. A project page shows health, stage, lead, members, progress, releases and its tasks.
- **All tasks** and **Bugs**: tabs All, My tasks, In progress, Blocked, Done; filters for project, owner, type and priority; list or board layout (drag cards between columns on the board).
- **Team**: each person's open tasks and blocked count.
- **Activity**: every change and comment, filterable by project and person; **Show more** loads older entries.

## Rules & gotchas
- If a task is not yours, the panel says only its owner and the Boss can change it; you can still comment. Unassigned tasks can only be changed by the Boss.
- Only the Boss can reassign or delete a task; deleting also removes its checklist, comments and files.
- Blocked always needs a reason; the Boss and the owner are notified.
- Only one release per project can be Current.
- A project's Short name cannot be changed after it is created. Archived projects leave the Roadmap; restore them from Projects → Archived → Edit project.
- You can only edit your own comments; a deleted comment leaves "This comment was deleted."
- The Development **Bugs** list is separate from Requests → Bug Reports, where staff report bugs.

## Related pages
- Bug Reports (`/bugs`) — bugs reported by staff, triaged by developers.
- Suggestions (`/suggestions`) — staff ideas and feature requests.
- Notifications (`/notifications`) — assignments, status changes, mentions and shipped releases.
