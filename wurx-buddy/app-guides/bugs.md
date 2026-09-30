---
slug: bugs
title: Bug Reports
route: /bugs
roles: [boss, ol, tl, pctl, apc, ipc, developer, ads_manager]
feature: feedback
last_reviewed: null
---
## What this page is for
Report something in WurxOS that is broken and follow it until it is fixed. Open it from **Requests → Bug Reports** in the sidebar (developers have **Bug Reports** as a top-level menu item).

## Who can use it
- **Everyone** can report a bug, see the bugs they reported, and chat with the developer on them. You only see your own reports.
- **Developers** triage: they see every bug, change its status, write dev notes and can delete reports. They are notified when a new bug comes in.
- **Boss** sees every bug and can reply and delete, but does not change the status (that button is developer-only).
- Boss and developers get two extra tabs, **All bugs** and **Reported by me**, plus count cards (Total, Open, In Progress, Fixed, Closed, Won't Fix).

## How to report a bug
1. Click **Report a bug** (top right).
2. Pick a **Bug type**: UI / Visual, Functional, Performance, Data / Sync, Login / Access or Other.
3. Pick a **Priority**: Low, Medium (default), High or Critical.
4. Enter a short **Title** and a **Description** — what happened, what you expected, and the steps to reproduce it.
5. Click **Submit**. The button stays disabled until type, title and description are filled in.

## How to follow up on a bug
1. Click the bug card to open it. You see its status, priority, type, your description and any **Dev notes**.
2. Use the **Discussion** box at the bottom: type a reply and click **Send** (or press Enter). New messages appear within about 10 seconds.
3. You get a notification when the status changes and when someone replies.

## How to triage a bug (developers)
1. Open the bug and click **Update status / notes**.
2. Choose a **Status** and add **Dev notes** (the reporter sees these).
3. Click **Save**. The reporter is notified of the new status.
4. To remove a report, click the bin icon in the bug's header and confirm.

## Rules & gotchas
- Statuses: **Open**, **In Progress**, **Fixed**, **Closed**, **Temp Closed**, **Won't Fix**. The Closed card counts both Closed and Temp Closed.
- There is no edit button for the reporter — if you got something wrong, add a correction in the Discussion.
- Use the search box (title / description) and the status, type and priority filters to find a bug; sort by **Newest**, **Oldest** or **Priority first**.
- This page is separate from the Bugs list inside the Development workspace; a bug reported here does not appear there automatically.
- For an idea or feature request rather than something broken, use Suggestions instead.

## Related pages
- Suggestions (`/suggestions`) — ideas and feature requests, not broken behaviour.
- Notifications (`/notifications`) — status changes and replies on your bugs arrive here.
- Development (`/development/roadmap`) — the Boss and developers' own task and bug tracker.
