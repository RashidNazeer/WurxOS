---
slug: leave
title: Leave
route: /leave
roles: [boss, ol, tl, pctl, apc, ipc, developer, ads_manager]
feature: hr
last_reviewed: null
---
## What this page is for
Use this page to request leave, work from home (WFH), a half day or anything else, and to approve your team's requests. To open it:
- Boss: **Requests → Leave Requests**
- Everyone else: **Requests → Leave**
- Developer: **Leave** in the sidebar

The **Leaves to approve** tile on the Dashboard opens the same page. Its address is `/leave/approvals`.

## Who can use it
- **APC, IPC, Developer and Ads Manager** see the **Requests** page with their own requests only.
- **TL and PCTL** get two tabs, **My Requests** and **Team Requests**. You can act on your direct reports' requests: APCs for a TL, IPCs for a PCTL.
- **OL** gets **My Requests** and **All Requests**. You can act on requests from TLs and PCTLs.
- **Boss** sees a different page, **Leave & WFH Requests**. It is a review queue only, with no New Request button.

## How to request leave
1. Click **New Request**.
2. Choose a **Request Type**: **Leave Request**, **Work From Home**, **Half Leave** or **Other**.
   - For Leave Request, also pick **Medical Leave** or **Emergency Leave**. The number in brackets is how many paid days you have left this month.
   - For Other, fill in **What do you need?**.
3. Set the **Start Date** and **End Date**, and write a **Reason**. All three are required.
4. Check the **Range breakdown**. Weekends and company holidays are not charged to your quota.
5. Click **Submit Request**. The **Confirm Submission** box shows how many days are **Paid (from monthly quota)** and how many are **Unpaid**. Confirm with **Submit Request**, or **Submit as Unpaid** if you have no paid quota left.
6. To cancel, click **Withdraw** on the request card. This works while the request is pending or after it's been rejected. Your quota is given back.

## How approval works
Each request moves through these steps. The card shows where it is (Pending TL, Pending PCTL, Pending OL or Pending Boss).
- **APC:** your TL (**Pending TL**) → optionally Boss.
- **IPC:** your PCTL (**Pending PCTL**) → optionally Boss.
- **TL or PCTL:** any OL (**Pending OL**) → optionally Boss.
- **OL, Developer, Ads Manager:** straight to **Pending Boss**. For an Ads Manager this holds even if they report to someone: only the Boss is notified and only the Boss decides.

At each step, the approver clicks **Approve** or **Reject** on the card.
- In the **Approve Request** box, tick **Forward to Boss for final approval** to send it on. Leave it unticked to approve it finally yourself.
- **Reject** needs a reason. The requester sees it on the card.

<!-- source: Owner decision Q1 (REVIEW.md); mig 390 leave_current_approver / leave_approver (ads_manager → Boss); src/lib/leaveApi.js mapStatusToV1 (ads_manager → pending_boss) -->

## How to review as a TL, PCTL or OL
1. Open **Team Requests** (or **All Requests** for an OL). The tab badge counts the requests waiting on you.
2. Use **Pending**, **Approved** or **Rejected**, plus search, category and date filters.
   - Pending shows every month, including future dates, so nothing waiting on you is hidden.
   - An OL also has an **All Stages** filter and an **All Roles** filter.
3. The **Approve** and **Reject** buttons appear only on requests at your step.

## How the Boss reviews
1. The tabs are **Pending** (every month), **Approved**, **Rejected**, **Unpaid** and **All**. Use the month navigator to browse past months.
2. **Unpaid** shows each person's unpaid days for the month, for salary deduction.
3. Click **Approve** on a **Pending You** request.
   - If it has unpaid days, choose **Approve as Unpaid** or **Approve as Paid**. Approve as Paid is a Boss override.
   - The box also shows the person's remaining paid quota for this month.
4. **Export CSV** downloads either **A specific month** or **All months (everything on record)**.

## Rules & gotchas
- Quotas reset every month. The defaults are Medical 1, Emergency 1 and WFH 2. The Boss changes them on Attendance → Leave Quotas.
- **Half Leave** uses half a day of your Medical quota.
- **Other** requests are always unpaid.
- The month navigator filters by each request's start date.
- The paid/unpaid split in the confirm box is only a preview. When you submit, the server works out the final split once. It uses your monthly quota, the leave already approved that month, weekends and company holidays. The numbers on your request card are the real ones. They don't change later unless the Boss approves unpaid days as paid.
  <!-- source: mig 055 trigger leave_compute_paid_bi (before insert); mig 159 leave_compute_paid_days; mig 167 holidays via _leave_working_days; client preview src/lib/leaveApi.js:177-199 -->

## Related pages
- Attendance (`/attendance`): approved leave counts toward your attendance, and the Boss sets quotas there.
- Holidays (`/holidays`): holiday days are never charged to your leave.
- Dashboard (`/dashboard`): shows your pending leaves and leaves to approve.
