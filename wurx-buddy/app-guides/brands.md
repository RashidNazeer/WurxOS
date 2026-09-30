---
slug: brands
title: Brands
route: /brands
roles: [boss, ol, tl, apc, ipc, ads_manager]
feature: brands
last_reviewed: null
---
## What this page is for
The list of brands the agency works on, shown as cards. Open it from the sidebar: it is called **Brands** for the Boss and Operation Leads, and **My Brands** for everyone else. Click any card to open that brand's own page.

## Who can use it
- **Boss and OL:** see every brand (page title "Brands"). They can add brands, edit any brand, filter by Team Lead, and use the **Switch** button on each card.
- **TL:** page title "My Brands". Can add brands (the TL is automatically the owner) and **Edit** brands they own.
- **APC, IPC, Ads Manager:** page title "My Brands". View only — you see the brands assigned to you. If you have none yet, the page says "Your Team Lead or the Boss will assign brands to you."
- PCTLs have no access to this list (they can still open a single brand's page from elsewhere).

## How to find a brand
1. Type in **Search by brand, client or TL…**.
2. Use the **Active / Inactive / All** chips (Active is the default).
3. Narrow further with **All clients**, **All tiers** and (Boss/OL only) **All Team Leads**. **Clear filters** resets the three dropdowns.
4. The subtitle shows how many brands match, e.g. "5 of 20 brands".
5. The refresh button (circular arrow) reloads the list.

Each card shows the brand's status (Active/Inactive), Tier, 30-day GMV, owning TL and the assigned APCs.

## How to add a brand (Boss, OL, TL)
1. Click **Add brand**.
2. Fill in **Brand name** (required) and optionally **Client name**, **Tier**, **GMV (30d)** and **Status** (Active/Inactive).
3. Choose the **Reporting currency** — it applies to every report and the client portal for this brand.
4. Set **Paid collab status** and **GMV Max status**. If the GMV Max status means the agency runs the ads, the brand's GMV Max Budget and Target ROI goals show in Brand analytics.
5. If the brand is on Euka, turn on **This brand is on Euka** and pick the store (required once the switch is on).
6. **Team Lead owner** (required): Boss/OL pick a TL; a TL is locked as the owner.
7. Under **Assigned APCs**, tick APCs from the owner TL's team. They are grouped as "Available" (no brand yet) and "Already managing" (with their brand count).
8. Optionally upload a logo, then click **Create brand**.

## How to edit a brand
Click **Edit** on the card (Boss/OL: any brand; TL: your own brands), change fields and click **Save changes**. The edit form also shows the brand's custom fields, resources and activity.

## How to change a brand's Team Lead (Boss, OL)
- **Boss:** click **Switch** on the card → "Switch brand owner". Pick the **New Team Lead owner**, optionally tick **Drop APC assignments** (by default the APCs stay on the brand), then **Switch brand**. A warning appears if the current APCs don't report to the new TL.
- **OL:** **Switch** opens "Request brand switch". Pick the **New Team Lead**, give a **Reason**, and click **Submit request** — only the Boss can reassign a brand's TL.

## Rules & gotchas
- You only see brands you are allowed to see: Boss, OL, PCTL and anyone given the "view all brands" permission see all; others see brands they own or are assigned to.
- When editing, the APC list only shows APCs under the chosen owner TL; changing the owner removes APCs who are not on that TL's team.
- Changing the reporting currency changes the symbol on all of that brand's reports, past ones included.
- Boss, OLs and every TL can add brands with **Add brand**. PCTLs don't have this page.
  <!-- source: src/pages/brands/BrandsPage.jsx:18-20 (canCreate = boss/OL/TL) -->

## Related pages
- Brand page (`/brands/:id`) — tabs, tasks, reports and APC reassignment for one brand.
- Brand Switcher (`/brand-switcher`) — review brand switch requests.
- Brand analytics (`/analytics/brands`) — goals and performance per brand.
