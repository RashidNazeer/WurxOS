---
slug: broadcasts
title: Broadcasts
route: /broadcasts
roles: [boss, ol, tl, pctl, apc, ipc, developer, ads_manager]
feature: comms
last_reviewed: null
---
## What this page is for
Company announcements. A broadcast is sent as a notification to the chosen people, and can optionally include a quick poll. Open it from **Broadcasts** in the sidebar.

## Who can use it
Every signed-in role can open the page and read the broadcasts sent to them. It is in the sidebar for Boss, OL, TL and APC; other roles can open it by link.
- **Boss, OL, Developer** can send to: **Everyone**, **By role**, **Specific users**, **Brand team**.
- **TL, PCTL** can send to: **My team** (your direct reports) and **Specific users** (chosen from your direct reports).
- **APC, IPC, Ads Manager** cannot send; they only read and answer polls.

## How to send a broadcast
1. Click **New broadcast**.
2. **Details** step: enter a **Title** (required) and an optional **Message** (it becomes the notification text). To send later, pick a date and time in **Schedule**; leave it blank to send now.
3. To collect answers, tick **Collect responses (poll)** and edit the **Response options** (1 to 6; the first defaults to "Acknowledged"). Use **Add option** or the X to remove one. Click **Continue**.
4. **Access** step: choose the **Audience**:
   - **Everyone** — every active user
   - **By role** — tick one or more roles
   - **Specific users** — tick people from the list
   - **My team** — your direct reports
   - **Brand team** — the brand's owner and its APCs; pick the brand
   Click **Continue**.
5. **Review** step: check Title, Audience and the **Recipients** count, then click **Send** (or **Schedule**).

## How to answer a poll
1. Open the broadcast from the list (or from its notification).
2. Under **Tap to respond**, click one option.
3. You can change your answer later by clicking another option.

## How to check poll results (sender)
1. Open your broadcast. **Results** shows how many responded and the count and percentage per option.
2. Use **All**, **Responded** and **Pending** to see who answered what.
3. Click **Ping** next to a person, or **Re-notify pending** to remind everyone who has not answered.

## Rules & gotchas
- Only the sender sees who picked what; recipients only see their own answer.
- Each card shows a status: **Delivered · N** (sent to N people), **Scheduled** (with "Sends at ..."), or **Pending…**.
- Broadcasts cannot be edited or deleted from this page.
- You see only broadcasts sent to you and the ones you sent. The Boss sees every broadcast.
- Only the people a broadcast was sent to can answer its poll. Who counts as a recipient is fixed when it's sent, so a later team or brand change doesn't add or remove anyone.
- Poll results are for the sender and the Boss. **Ping** and **Re-notify pending** reach recipients only.
<!-- source: Owner decision Q5 (REVIEW.md); mig 391 broadcast_recipients + bc_select / brspn_* / broadcast_respond / broadcast_renotify*; mig 393 bc_select (author row); src/lib/broadcastsApi.js isRecipient, listRecipients -->

## Related pages
- Notifications (`/notifications`) — where broadcasts arrive.
- Reminders (`/reminders`) — personal or scheduled reminders.
- Chat (`/chat`) — two-way conversations.
