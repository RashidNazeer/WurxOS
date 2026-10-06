---
slug: incentives
title: Incentives
route: /incentives
roles: [boss, ol, tl, pctl, apc, ipc, ads_manager]
feature: incentives
last_reviewed: null
---
## What this page is for
See your monthly incentive and bonus plan, update your progress, and (for managers) set up, verify and pay out everyone's plans. Open it from the sidebar: **Incentives**. What you see depends on your role.

## Who can use it
- **APC / IPC**: "My Incentives & Bonuses", managed by the Operations Lead.
- **TL / PCTL / Ads Manager**: "My Incentives & Bonuses" (your own plan only).
- **OL**: "Incentives & Bonuses" with tabs **APC Incentives**, **IPC Incentives**, **TL Incentives**, **Ads Managers**, **OL Incentives**, **My Incentives**.
- **Boss**: "Incentives Management" with tabs **APCs**, **Team Leads**, **Ads Managers**, **Operation Leads**.

## How to check and update your own progress (APC, IPC, TL, PCTL, Ads Manager, OL)
1. Pick the month with the month box (TL/PCTL: **Current** jumps back).
2. The card shows Basic Salary, Earned, **Total Earned** and Potential, plus a completion bar.
3. APC/IPC: **View Details** lists every item.
4. Click **Edit Progress** (OL: **My Incentives** tab → **Edit Progress**), type your **Achieved** values, and click **Save Progress**. APCs can tick **Notify team lead of progress update**.

## How an OL manages plans
1. Choose a tab and month; use search, status (No Plan / With Plan / Verified / Unverified) and team filters.
2. **Create Plan** or **Edit Plan** opens the plan editor for that person and month.
3. **Details** shows each item. There you can tick manual items complete, click **Edit** to change Target/Achieved and then **Save & Verify**, or just **Verify**. **Mark Unverified** reverses it and notifies the person.
4. **OL Incentives** tab: plans are read-only (set by the Boss), but an OL can verify OL plans, including their own.

## How the Boss manages plans and payouts
1. Pick the month; the **Combined payout** block totals everyone.
2. On a person's card: **Add** / **Edit** opens the plan editor; **Details** shows items.
3. **Verify** is on the Team Leads, Ads Managers and Operation Leads tabs (APC plans are verified by OLs).
4. **Clear Payout** marks it paid. If the plan is not verified yet you must confirm with **Clear Anyway**.
5. **Clear & Reset**: choose the month to clear and the next salary month; all plans for the first month are marked **Payout Cleared** and next month's plans are created with the same items and zero progress.

## Rules & gotchas
- Targets are read-only for the person; only Achieved can be typed.
- Most items count as completed at 90% or more of the target. A Commission Based Tier line pays a percentage of the brand's GMV above its benchmark and nothing at or below it.
- Some Achieved values fill themselves: attendance items from your monthly attendance %, GMV-Max items from Brand Analytics, commission lines set by the Operations Lead. You can't type those.
- Once the payout is cleared, **Edit Progress** disappears.
- Basic salary here is a monthly snapshot; salaries themselves are changed by the Boss under Salaries.
- On the OL page, a person with no plan this month may show last month's plan marked **Carried**; it is saved for the new month the first time it is edited or verified.
- Money is shown in PKR.

- APC and IPC plans are verified by an Operation Lead; a TL doesn't verify plans. Only the Boss or an OL can verify, and the person is notified.
  <!-- source: mig 351 inc_verify (boss / ol / developer gate; developer & boss targets Boss-only); BossIncentivesPage.jsx:560, :650-651; OLIncentivesPage.jsx:654, :931-940 -->
- PCTL plans are set and verified by the Boss only, on the Boss's **Team Leads** tab. OLs don't manage PCTL plans.
  <!-- source: Owner decision Q2 (REVIEW.md: stays as today); OLIncentivesPage.jsx:762 listUsersByRoles(['tl']); BossIncentivesPage.jsx:289 listUsersByRoles(['tl','pctl']) -->

## Related pages
- Incentive plan editor (`/incentives/edit/:userId`): where a plan's items and targets are set.
- Attendance (`/attendance`): feeds attendance-based items.
- Brand analytics (`/analytics/brands`): feeds GMV-Max items and brand GMV goals.
- My Compensation (`/me/compensation`): your salary record.
