---
slug: paid-collab-brands
title: Paid Collab — Brands
route: /paid-collab/brands
roles: [boss, ol, pctl]
feature: paid_collab
last_reviewed: null
---
## What this page is for
Shows every brand that has paid-collab creator deals, with its creators, videos, deal value and payment progress. PCTLs also use it to pick which workspace brands they manage. Open it from **Paid Collab → Brands** in the sidebar.

## Who can use it
- **Boss and Operation Leads** — can browse all brands and open any brand's details.
- **Paid Collab Team Leads (PCTL)** — same view, plus the **Pick workspace brands** button. Brands you have picked are highlighted and carry a **Managed** badge.

## How to find a brand
1. Type in **Search brand or product…** to filter by brand name or product.
2. Use the month drop-down (starts on **All months**) to show only deals from creators hired in that month.
3. The line under the page title sums up the view: brands, unique creators (deals), videos and total deal value.
4. Each brand card shows creators and deals, up to two products, a **Videos** tile, a **Deal value** tile (with the amount already paid) and small badges counting paid / pending / not yet deals.

## How to see a brand's creators and videos
1. Click a brand card. A window opens with the brand name, the period, and totals (total, paid and pending amounts).
2. The **Creators** tab lists each deal: Creator (links to their TikTok), Product, Deal, Payment, Videos, Hired by and Date.
3. The **Videos** tab plays each delivered video. Pick a video from the list on the right; its **Ad code** is shown under the player. If a link cannot be embedded you get an **Open on TikTok ↗** link instead.
4. Close the window with the X.

## How to pick the brands you manage (PCTL)
1. Click **Pick workspace brands**.
2. The list shows active workspace brands whose Paid Collab Status is set (anything other than "Not applicable"), with that status under each name.
3. Click a brand to select it (a tick appears); click again to unselect. Each click saves immediately.
4. Click **Done**.

## Rules & gotchas
- The brand cards come from the paid-collab tracking sheet, not from WurxOS brands. Edits to deals, payments or videos are made in the sheet. Click **Refresh** to pull the latest sheet data (otherwise it is cached for about 10 minutes).
- The picker list is separate: it comes from WurxOS brands. If it says no brands are flagged, ask the Boss or a TL to set the brand's Paid Collab Status.
- The **Managed** badge matches by brand name, so a sheet brand spelled differently from the WurxOS brand will not be highlighted.
- The brands you pick are the ones you can hand out to your IPCs on the IPCs page.
- Creators are counted once per brand (by TikTok handle, or name if no handle), so "creators" can be lower than "deals".
- On the brand card, the **Videos** tile's first number is how many deals have their video marked "Done", and the second is how many individual videos have been posted.
  <!-- source: src/pages/paidCollab/BrandsPage.jsx:95, :103-108, :249-251 (doneVideos = videoCounts.paid, totalVideos = sum of videoCodes.length) -->

## Related pages
- Paid Collab Dashboard (`/paid-collab/dashboard`) — overall totals (PCTL only).
- Creators (`/paid-collab/creators`) — all creator deals with filters.
- Videos (`/paid-collab/videos`) — videos per creator.
- IPCs (`/pctl/ipcs`) — assign your picked brands to IPCs.
