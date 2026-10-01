---
slug: creator-library
title: Creator Library
route: /creator-library
roles: [boss, ol, tl, pctl, ipc]
feature: brands
last_reviewed: null
---
## What this page is for
The creators the IPCs shortlist for each brand, and their approval: first by the brand's Team Lead, then by an Operation Lead. Open it from the sidebar: **Creator Library**. The creators themselves come from a shared Google Sheet the IPCs manage; approvals are done here.

## Who can use it
- **IPC:** sees creators for brands assigned to you; can send **Remind** / **Notify to review** nudges. Cannot approve.
- **TL:** sees creators for brands you own and can approve or reject at the **TL** level.
- **OL and Boss:** see all brands and can approve or reject at both the **TL** and **OL** level.
- **PCTL:** sees all brands, view only.
- APCs and Ads Managers have no access.

## How to find creators
1. The landing view shows totals (**Creators**, **Pending**, **Awaiting OL**, **Approved**, and **Rejected** if any) and one card per brand that has creators, most in need of review first.
2. Each brand card shows how many are "to review" (or **All approved**) and a coloured bar for Pending TL / Awaiting OL / Approved / Rejected.
3. Use **Search brands…** or the **All brands** / **All my brands** dropdown, or click a card (**Open**) to see that brand's creators.
4. Inside a brand, search with **Search name or @handle…** and filter by **All statuses**, **Pending**, **Approved by TL**, **Approved by OL**. **All brands** takes you back.
5. Each creator row shows name, a link to their TikTok, PayPal and Discord (click to copy), the Team Lead and Operation Lead decision badges (hover for the note), and any note from the sheet.

## How to approve or reject a creator (TL, OL, Boss)
1. Open the brand and find the creator.
2. Next to **TL** (or **OL**), click **Approve** or **Reject**.
3. In the "Approve as …" / "Reject as …" box, optionally add a **Note**, then click **Approve** / **Reject**.
4. To take a decision back, click **Undo** next to it.
The creator's status: Pending → Awaiting OL (after TL approval) → Approved (after OL approval). A rejection at either level shows as Rejected.

## How to ask for a review (IPC)
1. Click **Remind** on a brand card, or **Notify to review** inside a brand.
2. Optionally type a **Message** and click **Send**. The brand's Team Lead and the Operation Leads are notified (the PCTL is not).

## How to add or change creators
Creators are added and edited in the shared sheet by the IPCs, not on this page. After changing the sheet, click **Sync sheet** (top right) to pull the latest; the subtitle shows when it last synced.

## Rules & gotchas
- If a TL loses a brand, its creators disappear from their view straight away.
- Opening the page clears the blinking Creator Library alert in the sidebar.
- Decisions made here are also written back to the sheet (best effort); this page is the record that counts.
- OL/Boss see a note when some sheet rows couldn't be matched to a brand — check the "Brand" column spelling in the sheet.
- A creator row with no TikTok handle in the sheet is not shown.
- The status filter has no "Rejected" option; rejected creators appear under **All statuses**.
- An OL or the Boss can approve or reject at OL level at any time: before the TL has decided, or even after the TL rejected. The OL decision sets the creator's final status.
  <!-- source: mig 284 creator_set_approval (no check on tl_approved_by); src/lib/creatorLibraryApi.js:22-27 (OL decision wins) -->

## Related pages
- Brands (`/brands`) — brand ownership decides which TL approves.
- Notifications (`/notifications`) — where review nudges arrive.
