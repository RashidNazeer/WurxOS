---
slug: brand-detail
title: Brand page
route: /brands/:id
roles: [boss, ol, tl, pctl, apc, ipc, ads_manager]
feature: brands
last_reviewed: null
---
## What this page is for
Everything about one brand: its details, team, products, tasks, reports, GMV Max numbers, campaigns, resources and report setup. Open it by clicking a brand card on **Brands** / **My Brands**. **All brands** at the top takes you back.

## Who can use it
Anyone who can see the brand (Boss, OL and PCTL see all brands; others see brands they own or are assigned to). If you can't see it you get "Brand not found — You may not have access to this brand."
- **Boss, OL (and developers):** everything, including **Switch APC** and sharing reports with the client.
- **The brand's owning TL:** can edit the brand, assign temporary cover, and sees the **Activity** and **Settings** tabs.
- **Assigned APC/IPC:** can create tasks, edit products and resources, and record the tier sale date.
- Others with access (e.g. PCTL, Ads Manager): mostly view only.

## Header buttons
- **New task** — brand owner/editors and people assigned to the brand; active brands only.
- **Edit brand** — Boss, OL, owning TL. Opens the same form as on the Brands page.
- **Assign APC/IPC** — Boss, OL, owning TL; active brands only. Adds someone as temporary cover.
- **Switch APC** — Boss and OL only. Moves the brand to a different APC.

## Tabs
**Overview** (details, team, custom fields, tier sale tracker), **Products**, **Tasks**, **Reports**, **GMV Max**, **Campaigns**, **Resources**, **Report Links**, **Report Sections**, **Activity** (Boss/OL/owner only), **Settings** (Boss/OL/owner only).

## How to give temporary cover (Assign APC/IPC)
1. Click **Assign APC/IPC**. "Currently assigned" lists people as Permanent or "Temporary · until" a date; **Remove** takes someone off.
2. Search and pick an APC/IPC, set **Assigned until** (defaults to two weeks ahead, must be in the future), click **Assign**.
3. They get full access to work the brand and are removed automatically after that date.

## How to switch the brand's APC (Boss, OL)
1. Click **Switch APC** ("Reassign APC").
2. OL only: choose **Apply directly** or **Request from Boss**.
3. Choose **Assign only** (just this brand moves; the new APC keeps their other brands) or **Swap portfolios** (both APCs exchange their whole set of brands).
4. Pick the APC. A preview shows each person's brands before and after.
5. Add a **Note** (or **Reason for Boss** when requesting). Optionally tick **Notify the new APC and their Team Lead**.
6. Click **Confirm assign/swap** or **Submit assign/swap request**.
The brand's TL becomes the new APC's TL, and its open tasks, reports and resources move with it. A swap removes anyone else assigned to the moved brands (IPCs, temporary cover).

## How to record a tier sale (Overview tab)
On active brands with a tier that isn't "unlimited", the **Tier sale tracker** shows when the next sale is due (every 30 days). Pick the **Last sale generated** date, or click **Mark generated today**; **Clear** stops the reminders. Reminders start 3 days before it's due, then daily.

## Other tabs in short
- **Products:** **Add product**; set the **Monthly sample goal** to **Fixed targets** or **Unlimited**. Deleting a product also removes its campaigns.
- **Tasks:** filter all / todo / in progress / done; **New task**.
- **Reports:** every report for the brand with its status. Boss/OL tick **Share with client** — only approved reports can be shared.
- **GMV Max:** **Add Month** for monthly overview numbers, then **Add Campaign** inside a month.
- **Campaigns:** **Add Campaign** with Promotion Name, Status (Ongoing, Upcoming, Ended, Deactivated), start/end time and type.
- **Report Links:** sections of links (**New section**, **Add link**) that appear automatically in this brand's weekly, bi-weekly and monthly reports.
- **Report Sections:** extra sections (free text or a table of fields) that appear in this brand's future weekly and bi-weekly reports.

## Rules & gotchas
- An **inactive** brand shows a banner, and you can't add tasks, products, resources or GMV Max entries.
- There is no separate "switch TL" button here — use **Switch APC**; the TL follows the APC.
- Clicking a row in the Reports tab takes you to the Weekly Reports page, not straight into that report — open it from the matching reports page.
- **Report Links** and **Report Sections:** the brand team maintains them; anyone working on the brand can add, edit and remove them.
- **Campaigns:**
  - Anyone on the brand team (TL, APC, IPC, PCTL), plus OL, Developer and Boss, can add and edit.
  - Only the person who added a campaign, the brand's TL, an OL, a Developer or the Boss can delete it.
  - Ads Managers can view campaigns but can't add or change them.
  - You can't add campaigns to an inactive brand.
  <!-- source: mig 103 brr_* and mig 104 brs_*; mig 071 cmp_insert (no ads_manager) and cmp_delete; mig 195 cmp_update (brand team); mig 115 campaigns_block_inactive_brand -->

## Related pages
- Brands (`/brands`) — the list of brands, add a brand.
- Brand Switcher (`/brand-switcher`) — where switch requests are reviewed.
- GMV Max (`/gmv-max`) — GMV Max reporting across brands.
