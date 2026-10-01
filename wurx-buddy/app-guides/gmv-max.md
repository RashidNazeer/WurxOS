---
slug: gmv-max
title: GMV Max
route: /gmv-max
roles: [boss, ol, tl, pctl, apc, ipc, ads_manager]
feature: reporting
last_reviewed: null
---
## What this page is for
Record each brand's monthly GMV Max numbers from TikTok Ads Manager / Seller Center: a Monthly Overview plus per-campaign results. Open it from **Reporting → GMV Max** (Ads Managers: **GMV Max** in the sidebar). The page heading is "GMV Max Reporting". The same screen also appears on a brand's page under the **GMV Max** tab.

## Who can use it
- **Boss, OL, TL, PCTL, APC, IPC** can add, edit and delete months and campaigns.
- **Ads Managers** can open the page and read the data, but see no Add Month, Add Overview, Add Campaign or delete buttons.
- The brand list on the left is the brands you can see (e.g. your assigned brands).

## How to add a month
1. Pick a brand from the **Brands** list (use **Search brand…** if needed).
2. Click **Add Month**, choose the year and month.
3. Enter the 5 metrics: **Cost**, **SKU Orders**, **Cost per Order**, **Gross Revenue**, **ROI**, plus optional **Notes**.
4. Click **Save**.

## How to edit the Monthly Overview
1. Under the month, click **Edit Overview** (or **Add Overview** if it is empty).
2. Change the numbers and click **Save**.

## How to add or edit a campaign
1. Under the month's **Campaigns** card, click **Add Campaign** (or **Edit** on an existing campaign).
2. Fill **Campaign Name** (required), and optionally **Campaign ID**, **Target ROI**, **Schedule Time**, **Campaign Budget**.
3. Pick a **Status**: Active, Paused, Ended or Draft.
4. Enter the campaign's actual Cost, SKU Orders, Cost per Order, Gross Revenue and ROI, and click **Save**.
5. To remove a campaign, click its bin icon and confirm.

## How to delete a month
Click the bin icon next to the month title ("Delete this month"), then **Delete**. The overview and all its campaigns are removed permanently.

## Rules & gotchas
- Only monthly entries exist here, even though the page subtitle mentions weekly metrics. Weekly GMV Max figures go inside the Weekly Report form.
- Using **Add Month** for a month that already exists overwrites that month's overview numbers (its campaigns are kept).
- Money is shown in the brand's currency on the tiles; the field labels say USD.
- Nothing here goes through an approval chain; saves are live immediately.

- Ads Managers can view GMV Max data but can't add or change it; the server refuses their saves.
- Only an OL, the Boss or a Developer can delete a whole month.
<!-- source: mig 108 gmv_insert / gmv_update (boss, ol, tl, pctl, apc, ipc, developer — no ads_manager), gmv_delete (boss, ol, developer), gmv_select (any authenticated) -->

## Related pages
- Brand detail (`/brands/:id`): same data on the brand's **GMV Max** tab.
- Weekly Reports (`/weekly-reports`): weekly GMV Max section of the weekly report.
- Brand analytics (`/analytics/brands`): brand GMV figures and goals.
- Client Access (`/client-access`): a client link can include **GMV Max Reporting**.
