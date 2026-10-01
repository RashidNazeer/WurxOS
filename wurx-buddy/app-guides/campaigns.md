---
slug: campaigns
title: Campaign Tracker
route: /campaigns
roles: [boss, ol, tl, pctl, apc, ipc, developer]
feature: brands
last_reviewed: null
---
## What this page is for
Track TikTok Shop promotions (shop-wide campaigns) for your brands, with start/end times, a days-left countdown and expiry reminders. Open it from **Campaigns** in the sidebar.

## Who can use it
- **Boss, Operation Lead:** see and manage all campaigns, all brands.
- **Team Lead:** sees campaigns for brands they own; brand list = brands they own.
- **APC / IPC:** see campaigns only for brands assigned to them; brand list = assigned brands.
- **Paid Collab TL:** not in their menu; the page lists all brands, but they only see campaigns for brands they own or are assigned to.
- **Developer:** not in their menu, but has full access if opened.
- **Ads Manager:** not in their menu; the list stays empty and adding a campaign is refused.

## How to add one campaign
1. Click **Add Campaign** (the **Manual** tab opens).
2. Pick the **Brand** and enter the **Promotion Name** (both required).
3. Set **Status** (Ongoing, Upcoming, Ended, Deactivated) and **Type** (e.g. Coupon, Bundle, Flash Sale).
4. Set **Start Time** and **End Time** (leave End Time empty for an indefinite campaign). Add **Notes** if needed.
5. Click **Add Campaign**.

## How to add many from TikTok Shop (Paste & Parse)
1. Click **Add Campaign**, then the **Paste & Parse** tab.
2. Pick the **Brand** — it applies to all pasted rows.
3. Copy the promotions table from TikTok Shop Seller Center and paste it into the box.
4. Click **Parse Data**. Review the detected rows; edit any cell or remove a row with the cross. **Re-paste** starts over.
5. Click **Confirm & Add N Campaigns**.

## How to edit, delete or filter
1. Click the pencil on a row, change fields and click **Save Changes**.
2. Click the bin, then **Yes** to delete. To delete several, tick their boxes and click **Delete N** in the red bar.
3. Filter with the search box, **All Status**, **All Brands**, **All Types**, **All Added By**, and the **Start from** / **End by** dates. **Clear** resets them.

## How to get expiry reminders
Go to Settings → **Campaigns** and choose your lead times (e.g. 3 days before, 1 day before, On the day) and delivery time. Reminders go to the brand's owner and assigned team.

## Rules & gotchas
- The status badge updates by date: before start = **Upcoming**, between start and end = **Ongoing**, after end = **Ended**. **Deactivated** is never changed automatically.
- Reminders are only sent for campaigns whose saved Status is **Ongoing** and that have an End Time. A campaign saved as "Upcoming" gets no reminder even after its start date passes — edit it to Ongoing.
- Editing is allowed for the brand's team; deleting only for the person who added it, the brand owner, or OL/Boss.
- The page loads the most recent 500 campaigns.
- Times are shown in your browser's time zone.

## Related pages
- Product Campaigns (`/product-campaigns`) — per-product price promotions.
- Settings (`/settings`) — Campaigns reminder lead times.
- Brand detail (`/brands/:id`) — the brand itself.
