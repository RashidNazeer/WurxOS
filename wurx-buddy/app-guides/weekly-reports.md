---
slug: weekly-reports
title: Weekly Reports
route: /weekly-reports
roles: [boss, ol, tl, pctl, apc, ipc]
feature: reporting
last_reviewed: null
---
## What this page is for
Write, review and approve each brand's weekly performance report. Open it from the sidebar: **Reporting → Weekly Reports**.

## Who can use it
- **APC, IPC, PCTL, TL** see "Weekly Reports — Overview of your brands and report submission status": one card per brand you can see, with this week's status (Draft, Submitted, Verified, Approved, Pending or Overdue).
- **TL** also gets a **Needs My Review** card and filter, plus **Verify** and **Return to APC** on submitted reports.
- **OL and Boss** see the organisation-wide list ("All brand reports across the organization") with Drafts / Submitted / Approved / Pending approval cards, a month picker, search, week, client and team filters. Only the **OL** gets the approval buttons; the Boss gets **Edit Dates**, **Delete report** and the reminders.

## How to write and submit a weekly report (APC)
1. Click **New Report** (or open a brand card, then **New Report**).
2. Pick the brand. For a brand's very first weekly report you set the **Starting date** and **Week #**, then click **Confirm Starting Week & Begin Report**. After that the next week is picked for you.
3. Fill the sections (Seller Overview, GMV Max Performance, Product Highlights, Current & Upcoming Campaigns, Affiliate Overview, Top Creators, Top Videos, Operational Updates, Insights and more). The left rail shows how complete each group is.
4. Optional shortcuts: **Auto Generate from Euka** (only for brands linked to Euka) fills GMV, Affiliate GMV, Orders, top creators and top products; **Import from PDF** fills the form from a Google Doc export. Always check the numbers afterwards.
5. Click **Save Draft** to keep working later, or **Submit Report** to send it to your Team Lead. Submitting checks the required fields and lists anything missing.

## How to review a report (TL)
1. Open the brand, click the report.
2. Click **Verify** to pass it to the Operation Lead, or **Return to APC** and type a reason (required). You may then be asked how many reporting marks to deduct from the APC (default 1; 0 = none).
3. After verifying you can rate the report 0–5 stars under **Report quality (APC)**.
4. You can **Edit** a report while it is Draft or Submitted.

## How to approve a report (OL)
1. Open the report from the list (click a stat card to filter, e.g. **Pending approval**).
2. Status **Verified**: click **Approve** (final approval) or **Return to TL** with a reason.
3. If a TL or APC is unavailable: **Verify as TL** on a submitted report, or **Other options → Submit as APC** on a draft.
4. On an **Approved** report: **Reopen to Edit**, **Send Back to TL** or **Send Back to APC** (reason required).
5. Rate the TL under **TL reporting** (optional note the TL can read).
6. **Notify APCs** / **Notify TLs** on the Drafts / Submitted cards sends reminders (OL and Boss).

## Rules & gotchas
- Status flow: Draft → Submitted (APC) → Verified (TL) → Approved (OL). A returned report shows a red **Report Returned** panel with the reason and a **Return history**.
- Once you submit, you can't edit it unless it is sent back to you.
- An APC can't submit a new week until their previous report is at least verified by the TL.
- Only one report per brand per week. If the week already has a submitted report, the form warns you and blocks saving.
- ROI in Seller Overview is calculated from the GMV Max campaigns; you don't type it.
- Your typing is backed up on this device every 30 seconds. Leaving mid-report asks **Save & leave**, **Save & stay here** or **Exit without saving**.
- Only the OL can use **Change Week** inside the editor; OL and Boss can use **Edit Dates**.
- Clients never see a report just because it is approved. An OL or Boss must also tick **Share with client** on the brand's Reports tab.

- Only an OL, the Boss or a Developer can delete a report. If one needs deleting, ask your OL.
  <!-- source: mig 012 policy reports_delete (boss / ol / developer; not redefined later) -->
- Reports written by a PCTL or IPC go through the same chain as an APC's. The brand's Team Lead verifies them, then the OL approves. An OL can also **Verify as TL** from All Weekly Reports.
  <!-- source: mig 012 reports_update (brand owner may update); WeeklyReportsPage.jsx:324-331; AllWeeklyReportsPage.jsx:612 canVerifyAsTl -->

- A PCTL or IPC who wrote a report can **Edit** it while it's a draft, including when it has been returned to them, just like an APC. Once submitted, it can't be edited unless it's sent back.
  <!-- source: Owner decision Q3 (REVIEW.md); WeeklyReportsPage.jsx canEditReport (pctl/ipc: own draft); same rule on BiWeeklyReportsPage.jsx; mig 012 reports_update (author) -->

- Notifications are automatic:
  - Submitting alerts the brand's TL.
  - Verifying alerts all OLs.
  - Approving alerts the author and the brand's TL.
  - A report sent back to Draft alerts the author, and one sent back to the TL stage alerts the TL.
  - You never get a notification for your own action, and the Boss isn't notified.
  - If the brand has no TL, nobody is notified on submit.
  <!-- source: mig 221 reports_notify_on_status (trigger reports_notify_au from mig 012); mig 011 emit_notification skips recipient = actor; src/utils/reportNotifications.js:14-17 (handled by DB trigger) -->

## Related pages
- Bi-Weekly Reports (`/biweekly-reports`): the same flow on 14-day periods.
- Monthly Reports (`/monthly-reports`): the monthly version.
- GMV Max (`/gmv-max`): monthly GMV Max figures per brand.
- Brand detail (`/brands/:id`): Reports tab with the **Share with client** tick.
- Client Access (`/client-access`): the links clients use to see shared reports.
