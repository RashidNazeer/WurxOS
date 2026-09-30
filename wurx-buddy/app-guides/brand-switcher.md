---
slug: brand-switcher
title: Brand Switcher
route: /brand-switcher
roles: [boss, ol]
feature: brands
last_reviewed: null
---
## What this page is for
One place to move a brand to a different APC, and to review switch requests. Open it from the sidebar: **Brand Switcher**. (The old link `/boss/brand-switches` also lands here.)

## Who can use it
- **Boss:** changes take effect instantly, and the Boss approves or rejects pending requests.
- **OL:** can apply a change directly or send it to the Boss as a request, and can cancel their own pending requests.
No other role can open this page.

The counter at the top shows how many requests are **Pending** ("Awaiting your decision" for the Boss, "Awaiting Boss decision" for OLs).

## How to reassign a brand's APC
1. Stay on the **All brands** tab (it lists active brands only). Search with **Search by brand, client, APC, or TL…**.
2. Each row shows the brand, its current APC (with "+N" if more are assigned) and its TL. Click **Reassign APC**.
3. OL only: choose **Apply directly** or **Request from Boss**.
4. Choose what should happen:
   - **Assign only** — move this one brand; the new APC keeps every brand they already have.
   - **Swap portfolios** — both APCs exchange their whole book of brands.
5. Search for and pick the APC. The preview ("On confirm:" or "If Boss approves:") shows each person's brands before and after.
6. Add a **Note (optional)** — or a **Reason for Boss** if you are requesting.
7. Optionally tick **Notify the new APC and their Team Lead** (in-app + push). Leave it off for a silent change.
8. Click **Confirm assign** / **Confirm swap**, or **Submit assign request** / **Submit swap request**. After submitting a request you are moved to the **Pending** tab.

## How to approve or reject a request (Boss)
1. Open the **Pending** tab. Each row shows the brand, who asked and when, the target (→ APC with an **Assign** or **Swap** tag, or → TL for Team Lead change requests), and the reason.
2. Click **Approve**. For APC requests a confirmation spells out what will happen — read it: a Swap exchanges two whole portfolios.
3. Or click **Reject** and optionally type a rejection note.

## How to cancel your own request
On the **Pending** tab, click **Cancel** on a request you made, and confirm.

## Rules & gotchas
- Moving a brand to a new APC also moves it to that APC's TL, together with its open tasks, reports and resources.
- A swap is applied to the assignments as they are when the Boss approves, not as they were when the request was made. It also removes anyone else assigned to the moved brands (IPCs, temporary cover).
- Nothing changes on a request until the Boss approves it.
- The **History** tab lists requests that are no longer pending, with their status and any decision note.
- Team Lead change requests made from the **Switch** button on the Brands page also show up in these lists.
- Every OL (and the Boss) sees all switch requests in Pending and History, including ones other OLs raised. Anyone else sees only their own. You can cancel only your own pending requests, and only the Boss can approve or reject.
  <!-- source: mig 025 bsr_select / bsr_update (requester, boss, ol, developer); src/lib/brandSwitchApi.js listBrandSwitchRequests (no requester filter); BrandSwitcherPage.jsx:282 (Cancel only on own) -->

## Related pages
- Brand page (`/brands/:id`) — the same **Switch APC** action from inside a brand.
- Brands (`/brands`) — brand list; **Switch** to change a brand's Team Lead.
