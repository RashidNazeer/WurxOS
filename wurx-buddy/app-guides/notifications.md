---
slug: notifications
title: Notifications
route: /notifications
roles: [boss, ol, tl, pctl, apc, ipc, developer, ads_manager]
feature: comms
last_reviewed: null
---
## What this page is for
The full list of your in-app notifications (tasks, reports, leave, brands, broadcasts, reminders and more). Open it from **Notifications** in the sidebar, or click the bell icon and then **View all notifications**.

## Who can use it
Every role. You only ever see your own notifications.

## How to read and open notifications
1. Unread notifications are highlighted and have a dot; the page header shows how many are unread ("N unread" or "All caught up").
2. Click a notification to mark it as read and jump to the page it refers to.
3. Use **All** / **Unread** to switch between everything and only unread items.
4. When you have more than one type, use the type buttons (**All types**, **Tasks**, **Reports**, **Leave**, **Brands**, **Knowledge Base**, **Agenda Meetings**, etc.) to filter.
5. Click the refresh icon to reload.

## How to mark notifications as read
- One at a time: click the notification.
- All at once: click **Mark all read** (shown only when you have unread notifications). The bell panel has the same **Mark all read** link.

## How to snooze a notification
Snoozing is done from the pop-up (push) notification on your device, not from this page:
1. When a WurxOS push notification appears, use its buttons: **Mark as read**, **Snooze 10 min** or **Open**.
2. **Snooze 10 min** hides it and the notification comes back 10 minutes later.
3. **Open**, or clicking the notification itself, takes you to the related page.
<!-- source: public/sw.js:177-192 (body click = open) -->

## How to choose which notifications you get
Go to **Settings** and open the notification preferences section. There you can turn push notifications on for this device and choose which types you receive.

## Rules & gotchas
- The page and the bell show your 50 most recent notifications; the unread count covers all of them.
- Notifications cannot be deleted from this page.
- Notifications are created automatically by the app; nobody can send you one by hand except through a broadcast or a reminder.
- New notifications may also pop up briefly inside the app and play a chime (the chime can be turned off in Settings).

## Related pages
- Settings (`/settings`) — notification preferences and push setup.
- Broadcasts (`/broadcasts`) — announcements that arrive as notifications.
- Reminders (`/reminders`) — schedule a notification to yourself.
