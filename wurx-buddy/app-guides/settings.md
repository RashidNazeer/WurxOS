---
slug: settings
title: Settings
route: /settings
roles: [boss, ol, tl, pctl, apc, ipc, developer, ads_manager]
feature: admin
last_reviewed: null
---
## What this page is for
Your personal preferences (shift time, task resets, menu, theme, notifications, profile and password), plus admin settings for some roles. Open it from **Settings** in the sidebar. The left panel lists the sections in groups; use "Type to search…" to find one.

## Who can use it
Every role. Which sections you see depends on your role:
- **Everyone**: Time & Shift, Menu Layout, Appearance, System Popups, Category Push, Profile & Password.
- **Report Fields**: Boss, OL, TL, APC, Developer.
- **Campaigns** and **Product Campaigns**: everyone except Ads Manager.
- **Tier Notifications**: Boss, OL, TL, PCTL, APC, IPC.
- **Amazon Halo**: Boss, OL, TL. **Creator Library**: Boss, OL.
- **Ads Manager Brands**: Boss, OL. **My Incentive Brands**: OL only.
- **TikTok Ads**: Boss, OL, Ads Manager (Ads Managers can only view).
- **Paid Collab Brands**: PCTL, IPC, Boss, OL.
- **Leave Defaults**, **Payout Rates**, **Data Backup**, **Danger Zone**: Boss only.

## How to set your shift start and task reset times (Time & Shift)
1. Under **Your shift start**, enter **Shift start time** in Pakistan time and click **Save shift start**. If you have not clocked in an hour after this time, you get a reminder. Click **Clear** and save to turn the reminder off.
2. Under **Recurring task reset schedule**, set when Daily, Weekly (day + time) and Monthly (day 1–28 + time) tasks re-open. Click **Save changes**.

## How to reorder or pin your sidebar (Menu Layout)
1. Drag the handle, or use the up/down arrows, to change the order.
2. Click the star to pin an item to the top (click again to unpin).
3. Click **Save layout**. **Reset to default** restores the standard order.
You can only reorder items your role already has; nothing can be added.

## How to change theme and font (Appearance)
Pick **Light** or **Dark**, a font family and a font size. Changes apply instantly and are saved for this browser only.

## How to set up notifications
- **System Popups**: click **Turn on** to get push notifications on this device (allow them when the browser asks); **Turn off** to stop. **Registered devices** lists every browser receiving your pushes; click **Remove** on any you don't recognise.
- **Category Push**: switch **Notification sound** on/off, and choose which categories (Tasks, Development, Reports, Brands, Leave, Agenda, Paid Collab, Creator Library, Salary, HR, System) also send a push. In-app notifications are always on. Click **Save preferences**.
- **Campaigns** / **Product Campaigns**: **Enable expiry reminders**, choose a **Delivery time** (PKT, shared by both) and one or more lead times (14 days before … On the day). Click **Save preferences**.
- **Tier Notifications**: **Enable tier notifications** on/off, then **Save preferences**. Reminders are driven by the "Last sale generated" date on each brand's page.

## How to change your profile or password (Profile & Password)
- **Profile photo**: **Change** (PNG/JPG up to 5 MB, then frame it) or **Remove**.
- **Display name**: edit and click **Save**. Email and role can only be changed by an administrator.
- **Change password**: enter Current password, New password (at least 8 characters) and Confirm new, then **Change password**.

## Admin sections (by role)
- **Report Fields**: add, rename or delete your own custom fields that appear as extra sections on reports you write.
- **Ads Manager Brands** (Boss, OL): choose an ads manager, tick the brands they run ads for, click **Save brands**. This list is all that ads manager can see; with no brands they see nothing.
- **My Incentive Brands** (OL): tick the brands that count toward your incentive, then **Save my incentive brands**.
- **TikTok Ads**: **Connect TikTok Ads account**, map each ad account to a brand, **Check connection**, or disconnect (bin icon).
- **Amazon Halo**: tick brands to show in Amazon Halo; **Manage client links** for read-only client links.
- **Creator Library**: connect the shared Google Sheet (Web App URL, Shared secret, setup script, Published CSV URL), then **Save**.
- **Paid Collab Brands**: tick brands your team fills the weekly Paid Collab section for (saves instantly).
- **Leave Defaults**: starting WFH / Medical / Emergency quota for new users; **Save defaults**.
- **Payout Rates**: per-month conversion to PKR for commission incentives; enter a rate and click **Save**.
- **Data Backup**: **Back up all data now** downloads a file; upload it to Google Drive afterwards.
- **Danger Zone**: **Wipe all data…** permanently deletes operational data; requires typing DELETE EVERYTHING.
  - It also permanently deletes **every user account except the Boss who runs it**, as the "Will be deleted" list says.
  - Only your own account, the audit log and system configuration are kept.
  <!-- source: supabase/functions/wipe-data/index.ts:63-94 (wipe_all_operational_data, then deleteUser for every auth user except the caller); DangerZoneSection.jsx:164, :181 -->

## Rules & gotchas
- All times in Settings are Pakistan time, whatever your computer clock says.
- Push needs to be turned on separately on each browser/device you use.
- If notifications are blocked in your browser settings, **Turn on** is disabled until you allow them there.

## Related pages
- Notifications (`/notifications`) — your notification list.
- Tasks (`/tasks`) — recurring tasks follow the reset schedule set here.
- Attendance (`/attendance`) — clock in; the shift-start reminder is set here.
