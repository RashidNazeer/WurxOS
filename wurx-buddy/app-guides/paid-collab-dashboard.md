---
slug: paid-collab-dashboard
title: Paid Collab Dashboard
route: /paid-collab/dashboard
roles: [pctl]
feature: paid_collab
last_reviewed: null
---
## What this page is for
A read-only overview of paid-collab creator deals: how many creators were hired, for which brands, the total deal value, and how payments and video delivery are progressing. Open it from **Paid Collab → Dashboard** in the sidebar.

## Who can use it
Only Paid Collab Team Leads (PCTL). The Boss and Operation Leads do not have this page; they use Paid Collab → Brands, Creators and Videos instead.

## How to read the dashboard
1. The four cards at the top show:
   - **Unique Creators** — each creator counted once (by TikTok handle, or by name if there is no handle), with "X deals across Y brands" underneath.
   - **Brands** — number of distinct brands with deals.
   - **Deal Value** — the sum of all deal amounts in the period.
   - **Videos Posted** — total videos delivered across all deals.
2. **Payment Status** shows progress bars for Paid, Pending, Not Yet (and Unknown if some deals have no clear status), each as "done/total (percent)".
3. **Video Delivery** shows bars for Done and In Progress (plus Not Yet / Unknown when present).
4. **Top Brands** lists up to 8 brands with the most deals, with their creator count, deal count and total deal value.
5. **Recent Creators** lists the 6 most recently hired creators with their brand, product, payment pill and video pill.

## How to look at one month
1. Use the drop-down at the top right. It starts on **All Time (N deals)**.
2. Pick a month to limit every card, bar and list to creators hired in that month.
3. Pick **All Time** again to go back.

## Rules & gotchas
- Nothing can be edited here. The data comes from the paid-collab tracking sheet; changes are made in the sheet, not in WurxOS.
- One creator can have several deals (for different brands or products), so "Unique Creators" is usually smaller than the number of deals.
- The month filter uses the creator's hiring date, not the date a video was posted or a payment was made.
- Deal Value is read from the deal text in the sheet (the first number found). A deal written without a number counts as 0.
- Data is cached for about 10 minutes. This page has no Refresh button; the Refresh button on Paid Collab → Brands, Creators or Videos reloads the sheet data.
- To check each deal's video status, use the Videos filter on Paid Collab → Creators.

## Related pages
- Paid Collab — Brands (`/paid-collab/brands`) — the same deals grouped per brand, plus picking your managed brands.
- Creators (`/paid-collab/creators`) — every creator deal with filters.
- Videos (`/paid-collab/videos`) — watch delivered videos and copy ad codes.
- IPCs (`/pctl/ipcs`) — manage the IPCs who report to you.
