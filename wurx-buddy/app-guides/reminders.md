---
slug: reminders
title: Reminders
route: /reminders
roles: [boss, ol, tl, pctl, apc, ipc, developer, ads_manager]
feature: comms
last_reviewed: null
---
## What this page is for
Personal reminders: schedule a ping to yourself that arrives as a notification at the time you choose. Open it from **Reminders** in the sidebar.

## Who can use it
Every signed-in role can open it. It is in the sidebar for Boss, OL, TL and APC; other roles can open it by link. Reminders are private — you only see your own, and they are only sent to you.

## How to create a reminder
1. Click **New reminder**.
2. Enter a **Title** (required) and an optional **Note (optional)**.
3. Set **When** (date and time).
4. Click **Save**. The reminder appears under **Upcoming**.

## How to read the list
- **Upcoming (N)** — reminders that have not fired yet. The coloured badge shows how soon (e.g. "in 2h"): red if under an hour, amber if under a day.
- **Past (N)** — reminders that have already been sent as notifications.
- Click the refresh icon to reload the list.

## How to delete a reminder
1. In **Upcoming**, click the X on the reminder.
2. Confirm. Past reminders cannot be deleted from this page.

## Rules & gotchas
- There is no edit; delete the reminder and create a new one instead.
- Always check the **When** value before saving. A reminder whose time has already passed is sent within a minute.
  <!-- source: mig 035 fire-due-reminders every minute, remind_at <= now() -->
- The page shows your 100 most recent reminders.

## Related pages
- Notifications (`/notifications`) — where your reminders arrive.
- Tasks (`/tasks`) — for to-dos with status and due dates.
- Settings (`/settings`) — notification preferences.
