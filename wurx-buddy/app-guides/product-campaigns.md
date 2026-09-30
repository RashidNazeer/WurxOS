---
slug: product-campaigns
title: Product Campaigns
route: /product-campaigns
roles: [boss, ol, tl, pctl, apc, ipc, developer, ads_manager]
feature: brands
last_reviewed: null
---
## What this page is for
Track price promotions on individual products (product discounts, cart-level promotions, coupons), see each product's current price after discounts, and get reminders before promotions end. Open it from **Product Campaigns** in the sidebar.

## Who can use it
- **Boss, Operation Lead (and Developer):** see every product campaign and can add them for any brand.
- **Team Lead, APC, IPC and others:** see and add campaigns only for brands they own or are assigned to.
- The menu entry appears for Boss, OL, Team Lead and APC. Other roles can open the link but only see brands they're on.

## How to add a product campaign
1. Click **Add Campaign**. If you have more than one brand and none is filtered, pick one in **Select Brand**.
2. In **Select Product**, choose the product. Products come from the brand's Products tab — add them there first if the list is empty.
3. Add promotions either way:
   - Click **Paste Price Breakdown**, paste the price breakdown from TikTok Shop, click **Parse**, check the result, then click **Apply**.
   - Or click **Add** and fill each promotion: type (**Individual Product Promotion**, **Cart Level Promotion**, **Coupon**), name, discount ($), start date and end date.
4. Check the **Final Price** preview.
5. If the product has SKU variants, you can override the discount per SKU under **SKU Variants** (the reset arrow returns to the main discount).
6. Click **Add Campaign**.

## How to edit or remove
1. Click the **…** menu on a product card.
2. Choose **Edit** to change promotions, then **Save Changes**.
3. Choose **Remove Campaign** and confirm. The product itself stays on the brand.

## How to filter
Use **Search products...** (name or product ID), **All Brands**, **All Types** (Focus / Non-Focus), and **All Status** (**Active Promos**, **Ending Soon** = ending within 3 days, **All Expired**). **Clear** resets them.

## How to get expiry reminders
Go to Settings → **Product Campaigns** and choose your lead times and delivery time. Reminders go to the brand's owner and assigned team, per promotion.

## Rules & gotchas
- Each product has one campaign. Choosing a product that already has promotions loads them, and saving replaces them.
- A promotion is marked expired automatically after its end date; expired discounts no longer reduce the current price.
- A red stripe and "Nd left" badge mean a promotion ends within 2 days.
- SKU names and retail prices are edited on the brand's Products tab, not here.
- Discounts and prices are in dollars.
- Only the person who added the campaign, the brand owner, or OL/Boss can remove it.
- If a save fails with "Failed to save. Please try again." you may not be on that brand's team.

## Related pages
- Campaign Tracker (`/campaigns`) — shop-wide promotions per brand.
- Brand detail (`/brands/:id`) — the Products tab where products and SKUs are managed.
- Settings (`/settings`) — Product Campaigns reminder lead times.
