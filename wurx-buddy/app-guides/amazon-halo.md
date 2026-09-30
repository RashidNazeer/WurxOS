---
slug: amazon-halo
title: Amazon Halo
route: /halo
roles: [boss, ol, tl]
feature: analytics
last_reviewed: null
---
## What this page is for
Shows how a brand's TikTok Shop activity moved together with its Amazon results over a period, and how sure we can be about it, using sheets you upload. Open it from the sidebar: **Amazon Halo**. The old address `/halo-v2` now opens this same page.

## Who can use it
Boss, Operation Leads and Team Leads. Only brands switched on for Halo appear here; if none are, the page says "No brands are enabled for Halo yet" with a link to **Settings, Amazon Halo**, where brands are enabled.

## How to pick a brand
Use the brand dropdown at the top right. It lists only Halo-enabled brands.

## How to upload or replace sheets
1. Click **Manage sheets**.
2. The drawer has three slots: **Daily sheet** (one row per day), **Weekly sheet** (one row per week) and **Monthly sheet** (one row per month). At least one is needed; weekly and monthly views fall back to rolling up the daily sheet when their own sheet is missing.
3. Choose an .xlsx, .xls or .csv file in a slot. You'll see how many rows were read, the date range, products, search keywords and any columns that were "Not recognised".
4. Click **Save** (or **Replace** if a sheet is already there). **Cancel** discards the file.
5. To remove a sheet, click **Delete** next to it and confirm.
6. Weekly only: **Or build from a search-volume sheet** lets you upload just the Weekly Search Volume roll-up; it is combined with the daily sheet (upload the daily sheet first), then click **Build weekly** / **Rebuild weekly**.

## How to read the explorer
- **View:** Daily / Weekly / Monthly (a dot marks the one recommended for the data). The date chip changes the range (**Last 30 days**, **Last 90 days** or From/To).
- **View mode:** **Meeting** is the client-friendly view; **Lab** adds metric pickers (TikTok activity vs Amazon outcome), **Analyst options** (Halo window, Adjust for trend, Adjust for seasonality, Index to 100, Show scatter), **Terms** and **Reset**. The page remembers your last mode.
- **Methodology** explains how the numbers were produced.
- The page walks through **Step 1 · See**, **Step 2 · Adjust**, **Step 3 · Estimate** and **Step 4 · Plan**. Steps 2–4 are blurred in Meeting mode and fully usable in Lab.

## How to share with a client
1. Click **Share** → **Share with a client** (if a brand has no sheets yet, use the **Client links** button at the top instead).
2. In **Share Amazon Halo**, tick the **Brands for this link** (**Select all** / **Clear** help), add an optional **Label** and an optional **Expires** date (blank = never expires).
3. Click **New link**, then **Copy** the link from **Existing links** and send it.
4. Anyone with the link can view the explorer for those brands, read-only, with no login. Each link shows its view count. **Revoke** stops it working.
Client links always open in Meeting mode. Older Halo links made before this page replaced the original tool still open, and now show this view.

## How to download
**Share** → **Download one-pager (PDF)** or **Export CSV for finance**. In Lab mode there is also **Download PNG image**.

## Rules & gotchas
- Uploading a sheet in a slot replaces that brand's existing sheet of the same kind.
- If there isn't enough history, the page shows a guided panel and may suggest switching Daily/Weekly/Monthly.
- Boss, OLs and TLs have the same Halo rights. Each can upload, replace or delete sheets, and create or disable client links, for **any** Halo-enabled brand, not only their own. They can also change which brands are Halo-enabled.
  <!-- source: mig 281 is_halo_viewer (boss + active ol/tl, no per-brand check); mig 244 halo_* policies; mig 267 halo_create_dataset / halo_brands_all; mig 331 halo_v2_shares_* -->

## Related pages
- Settings (`/settings`) — the Amazon Halo section chooses which brands appear here and also manages client links.
