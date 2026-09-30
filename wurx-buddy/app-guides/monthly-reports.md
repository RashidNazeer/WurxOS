---
slug: monthly-reports
title: Monthly Reports
route: /monthly-reports
roles: [boss, ol, tl, pctl, apc, ipc]
feature: reporting
last_reviewed: null
---
## What this page is for
Write, review and approve each brand's monthly report. Open it from **Reporting → Monthly Reports**.

## Who can use it
- **APC, IPC, PCTL, TL** see a list of monthly reports for their brands ("Your monthly brand reports", or "Reports for your brands" for a TL) with search, year, month, brand and status filters, and a **New Monthly Report** button.
- **TL** can **Verify** or **Return to APC** a submitted report.
- **OL and Boss** see all monthly reports with Reports / Brands / Total GMV / Drafts / Submitted / Pending Approval / Approved cards (click a card to filter). Only the **OL** gets the approval buttons; OL and Boss can **Edit Month**, delete reports and send reminders.

## How to write and submit a monthly report
1. Click **New Monthly Report** and pick the brand.
2. For a brand's first monthly report, pick the month from the list. After that the next month is detected for you.
3. Fill the sections: Total Sales, Key Metrics, KPI's, GMV Breakdown, Top Creators, Top Videos, Video Performance, Creators' Performance, Product Analytics, GMV Max Performance, Customers, Key Wins / Insights, Campaigns, Recommendations & Action Items.
4. Optional: **Import from PDF** fills the form from a monthly report PDF (Google Doc export). Review before submitting.
5. Click **Save Draft**, or **Submit** to send it for review. Missing required fields are listed (e.g. Month GMV, All-time GMV, Key Metrics GMV and Orders, Completed Collabs, Total Orders, at least one creator, video, product and GMV Max campaign).

## How to review and approve
1. **TL:** open a Submitted report → **Verify** ("pass it to OL") or **Return to APC** with a reason. You may be asked how many reporting marks to deduct from the APC.
2. **OL:** open a Verified report → **Approve** or **Return to TL**. You can also **Verify as TL**, **Submit as APC** (under **Other options**), and on approved reports **Reopen to Edit**, **Send Back to TL** or **Send Back to APC**.
3. OL/Boss: the **APCs** / **TLs** buttons on the Drafts / Submitted cards send reminders.

## Rules & gotchas
- Status flow: Draft → Submitted → Verified → Approved. Returned reports show the reason.
- An APC can't submit a new month until the previous month's report is **approved by the OL** (weekly and bi-weekly only need TL verification). You can keep drafting meanwhile.
- One report per brand per month for APCs; a second submit for the same month is blocked.
- In the editor, **Change month** moves an existing report to another month.
- Only an OL, the Boss or a Developer can delete a report. If one needs deleting, ask your OL.
  <!-- source: mig 012 reports_delete (boss / ol / developer) -->
- Clients see an approved report only after an OL/Boss ticks **Share with client** on the brand's Reports tab.
- A PCTL's monthly report moves forward like any other. The brand's Team Lead verifies it, then the OL approves (an OL can also verify from All Monthly Reports).
  <!-- source: MonthlyReportsPage.jsx:40-41, :176-188 (canTlVerify for any tl); AllMonthlyReportsPage.jsx:283-298; mig 012 reports_update; mig 221 notify trigger -->

- A PCTL who wrote a monthly report can **Edit** their own draft, including one returned to them, as APCs and IPCs can.
  <!-- source: Owner decision Q3 (REVIEW.md); MonthlyReportsPage.jsx canApcEdit (pctl: own draft) -->

## Related pages
- Weekly Reports (`/weekly-reports`): full description of the shared approval flow.
- Bi-Weekly Reports (`/biweekly-reports`): 14-day version.
- GMV Max (`/gmv-max`): monthly GMV Max overview and campaigns per brand.
- Client Access (`/client-access`): client links that can include monthly reports.
