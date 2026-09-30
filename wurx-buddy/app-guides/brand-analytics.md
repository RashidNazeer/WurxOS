---
slug: brand-analytics
title: Brand analytics
route: /analytics/brands
roles: [boss, ol, pctl, ads_manager, tl, apc, ipc]
feature: analytics
last_reviewed: null
---
## What this page is for
Monthly goals per brand and how each brand is pacing against its GMV goal ("Real-time tracking of affiliate GMV goals"). Open it from the sidebar: **Brand analytics**.

## Who can use it
- **Boss and OL:** see all active brands and can set or edit goals and achieved figures.
- **TL:** can set or edit goals and achieved figures for the brands they own.
- **PCTL, APC, IPC, Ads Manager:** view only — no edit buttons are shown. You see the brands you have access to (Ads Managers see only the brands assigned to them).
IPCs can open the page by its link but it is not in their sidebar.

## How to read the dashboard
1. Pick the month with the arrows; click the month name to **Jump to this month**.
2. Search with **Search brand or client…** and filter with the chips **All**, **On track**, **With goals**, **Needs goals** (each shows a count).
3. The summary bar shows how many brands with goals are on track, and total achieved vs total goal. The thin line marks where you should be by today.
4. Each brand card shows a status — **Goal met**, **On track**, **Behind** or **Needs goals** — plus Achieved, Goal, Remaining, a pace bar and "% of pace". A pulsing dot means it was updated in the last 12 hours.
5. Click a card to open that brand's detail view; **Brands** (back arrow) returns to the grid.

## What the brand detail shows
Up to five cards, each with a goal and an achieved value: **Monthly GMV Goal**, **Sample Approvals**, **Paid Collab Budget**, **GMV Max Budget**, **Target ROI**.
- Paid Collab Budget only appears if the brand's paid collab status says the agency manages it; GMV Max Budget and Target ROI only if its GMV Max status says so. A note under the cards tells you what is hidden and that you can change it in **Brands**.
- For budgets, going over 100% shows **Over budget**.
- If the brand has an unlimited sample goal, Sample Approvals shows **Unlimited** / "No cap".
- **Linked GMV Max incentive** lists everyone whose "Total Revenue in GMV Max" incentive line is tied to this brand, with "X of Y achieved". A line counts as achieved at 90% of the goal; **Paid** lines are frozen.

## How to set or edit goals (Boss, OL, owning TL)
1. Open a brand (or click **Set goals** on a card with no goals).
2. Click **Set goals** / **Edit goals** at the top right.
3. For each metric enter the goal/allocated value and the achieved/used/actual value.
4. For Sample Approvals choose **Fixed goal** or **Unlimited**. Unlimited applies to the brand in every month, not just this one.
5. Click **Save goals**.

## Rules & gotchas
- Changing the **Monthly GMV Goal** also changes the "Total Revenue in GMV Max" incentive target for everyone on the brand (APC, Team Lead, Ads Manager) for that month. The form warns you when you change it. Cleared payouts keep their frozen figures.
- A TL editing achieved figures on their own brands is allowed, and every change is logged with before/after values.
- The page refreshes by itself when new figures are saved.
- If a month fails to load ("maybe a connection blip"), use the month arrows to retry.

## Related pages
- Brands (`/brands`) — change a brand's paid collab / GMV Max status.
- Brand page (`/brands/:id`) — Products tab also sets the monthly sample goal mode.
- Incentives (`/incentives`) — where the GMV Max incentive lines live.
