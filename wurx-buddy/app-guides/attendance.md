---
slug: attendance
title: Attendance
route: /attendance
roles: [boss, ol, tl, pctl, apc, ipc, developer, ads_manager]
feature: hr
last_reviewed: null
---
## What this page is for
This is where you clock in and out, take breaks, fix mistakes in your times and see your monthly attendance. Managers also use it to watch their team. Open it from the sidebar with **Attendance**. All times on the page are Pakistan time.

## Who can use it
- **APC, IPC, Developer and Ads Manager** have two tabs, **Today** and **History**. You only see your own attendance.
- **TL and PCTL** have **Today**, **Team** and **History**. On Today you also get a **Pending Approvals** card with your team's requests.
- **OL** has **Today**, **Team** (the whole company), **History** and **Roster**.
- **Boss** doesn't clock in. Boss has **Today** (the whole-company table), **History**, **Roster** and **Leave Quotas**.

## How to clock in and out
1. On **Today**, click **Clock in**, then choose where you're working from: **Bahria Office**, **Lake City Office** or **Work From Home**.
2. **APCs only:** the app may first ask you to enter each brand's GMV. It shows "Enter today's GMV", or on the first clock-in of a new month "Close off <month>". Type numbers only, then click **Review**, then **Confirm & clock in**. If you close this box, you are not clocked in.
3. To take a break, click **Take break**. When you're back, click **End break**. You can't clock out while you're on a break.
4. To finish your shift, click **Clock out**.
   - **TL, OL, PCTL, Developer and Ads Manager** are clocked out straight away.
   - **APC and IPC:** see the next section.
5. If you clocked out by mistake, click **Resume** in the "Clocked out by mistake?" box. Your time won't be lost. This works only during the same shift day, and not after an automatic close.

## How clock-out approval works (APC and IPC)
1. Before you can clock out, all of your daily tasks must be done. If they aren't, you'll see "You have N incomplete daily task(s) in <brand>…".
2. If your team lead isn't clocked in, or has switched on **Allow team to clock out without approval**, you're clocked out directly. A banner on your clock tells you when this applies.
3. Otherwise a **Clock Out** box asks "What did you work on today?". Fill it in and click **Clock Out**. Your status changes to "Waiting for team lead approval…".
4. Your approver is the person you report to: your TL for an APC, your PCTL for an IPC. They open **Today → Pending Approvals → Review** and click **Approve** or **Reject**.
5. If they reject it, you'll see **Clock-out Rejected** with their reason, and you stay on the clock. Finish the work, then clock out again.

## How to fix your clock-in time or breaks
1. While you're clocked in, click **Edit time**. Pick the correct time. It must be within the last 18 hours and not in the future.
   - APC and IPC: add a **Reason** and click **Send Request**. Your approver reviews it.
   - Everyone else: click **Save**. The change applies immediately.
2. Click **Edit breaks** to add, change or **Remove** breaks. APC and IPC must give a **Reason** and click **Send Request**.
   - Break edits go for approval for every role. Your request goes to the person you report to (the Boss if you have none). An OL, a Developer or the Boss can approve any break request, their own included.
3. While a request is waiting, a banner says it's "waiting for approval".
<!-- source: src/components/attendance/ClockWidget.jsx:688-695 (att_request_break_edit for all roles); mig 168 att_request_break_edit; mig 173 att_decide_edit (boss / ol / developer / reports_to) -->

## How to check your history
On **History**, pick a **Month** (and optionally a **Day**) and use the filters. **Refresh** loads today's latest records, and **Export CSV** downloads what's shown. The **My attendance** card on Today shows days present, days on leave, days missed and hours worked this month.

## How managers use Team, Roster and Leave Quotas
- **Team** (on Today for Boss): tiles for **Working**, **On Break**, **Pending**, **Done** and **Missing** (not clocked in). Click a tile to filter the table.
  - TLs and PCTLs get a **Review** button on pending clock-outs.
  - Boss gets **Close** to end someone's open session. Boss picks the clock-out time and can add a reason, and the person is notified.
- **Roster** (Boss, OL): one card per person, rated **On track**, **Watch** or **Behind**. Click **Adjust** to open a calendar. Tap a red day to mark it present, or tap a yellow day to undo. **Shift+click** a second day to mark a whole range. There's also a button to **Mark all missed days as present**. You can add an optional note, which the person sees.
- **Leave Quotas** (Boss): set the monthly **Medical Leave**, **Emergency Leave** and **Work From Home** allowance, then click **Save Quotas**. If someone has already used more than the new limit, you're asked to confirm with **Save Anyway (existing stay paid)**.

## Rules & gotchas
- An OL can't adjust their own attendance or another OL's in Roster. Those cards show "No edit access".
- Only a TL can switch on **Allow team to clock out without approval**. A PCTL doesn't get this switch.
- After 9 hours on the clock you'll see a "Still working?" banner. Click **Yes, still working** to snooze it, or **Dismiss** to hide it.
- If you set **Your shift start** in Settings, a reminder pops up when you haven't clocked in an hour after that time.
- Use the buttons to clock in, take breaks and clock out.
- If you forget to clock out, the system closes your session automatically **11 hours** after you clocked in, and records your clock-out at that 11-hour mark. This applies whether you were working, on a break or waiting for clock-out approval. You can't **Resume** an auto-closed shift; ask your manager to correct the time.
  <!-- source: mig 202 auto_clock_out_overdue_shifts (created_at + 11h, auto_closed = true); cron 'auto-clock-out-overdue' every minute, mig 154 (not unscheduled later); mig 173 resume blocked -->

## Related pages
- Leave (`/leave`): leave and WFH requests. Approved leave counts toward your attendance.
- Holidays (`/holidays`): company holidays count as present for everyone.
- Performance (`/performance`): attendance is one of the four score pillars.
