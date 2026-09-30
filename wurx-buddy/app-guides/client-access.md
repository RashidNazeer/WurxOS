---
slug: client-access
title: Client Access
route: /client-access
roles: [boss, ol]
feature: reporting
last_reviewed: null
---
## What this page is for
Create and manage the private links clients use to see their brands' data in the client portal (no WurxOS login needed). Open it from the sidebar: **Client Access**.

## Who can use it
Boss and Operation Leads only. Both see and manage all client links.

## How to create a client link
1. Click **New Client Link** (or **Create first link** when there are none).
2. Enter a **Link name** (the display label, e.g. "Client - Brand") and optionally an **Internal label**. At least one of the two is required.
3. Tick the **Share types** the client may see: Weekly Reports, Bi-Weekly Reports, Monthly Reports, Paid Collab, GMV Max Reporting. At least one is required.
4. Tick the **Brands** (search, **Select all**, **Clear**). At least one is required.
5. Click **Create link**.

## How to send the link to a client
On the link's card, click **Copy** next to the URL and send it to the client.

## How to change, pause or delete a link
- **Edit** (pencil icon): change name, share types or brands, then **Save changes**. The URL stays the same.
- **Disable / Enable** (pause/play icon): the card turns grey and shows **Disabled**.
- **Delete** (bin icon), then **Delete** to confirm: the link is removed permanently and stops working immediately.

## How to find a link
Use **Search by client or brand…**, the status filter (All Status / Active / Disabled) and the **All Clients** filter; **Clear** resets them.

## Rules & gotchas
- Only active brands appear in the brand picker.
- A report is not shown to the client just because it is approved. On the brand's page, **Reports** tab, an OL or Boss must also tick **Share with client**; that box only works for approved reports.
- The **All Clients** filter groups links by the brand's client name, which is filled automatically from the linked brands.
- Cards marked **Legacy v1 link** show the old v1 URL; it still works and redirects to the current portal.

- Disabling a link blocks it immediately: the client sees an "access disabled" message instead of the portal. Turning it back on restores access with the same URL. Revoked or expired links are refused the same way.
<!-- source: mig 322 get_client_access (raises access_disabled / access_revoked / access_expired); mig 146 _client_access_check used by mig 147 client_section_* ; src/lib/clientAccessApi.js:105-108 -->

## Related pages
- Brand detail (`/brands/:id`): **Reports** tab has the **Share with client** tick per report.
- Weekly Reports (`/weekly-reports`), Bi-Weekly Reports (`/biweekly-reports`), Monthly Reports (`/monthly-reports`): where reports are approved before sharing.
- GMV Max (`/gmv-max`): the GMV Max data a link can expose.
