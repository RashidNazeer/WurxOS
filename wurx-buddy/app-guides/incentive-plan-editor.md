---
slug: incentive-plan-editor
title: Incentive Plan Editor
route: /incentives/edit/:userId
roles: [boss, ol, tl, pctl, apc, ipc]
feature: incentives
last_reviewed: null
---
## What this page is for
Build or change one person's incentive and bonus plan for one month. You reach it from **Incentives**: the Boss clicks **Add** / **Edit** on a person's card; an OL clicks **Create Plan** / **Edit Plan**. The month is the one you were viewing on the Incentives page.

## Who can use it
In practice the **Boss** and **Operation Leads**: only their Incentives pages link here. An OL edits plans for APCs, IPCs, TLs and Ads Managers; OL plans are set by the Boss. Other roles are allowed to open the address but have no button leading to it.

Plans are created and changed by the Boss and Operation Leads. Other roles can't create a plan or change someone else's; the save is refused.
<!-- source: mig 301 inc_insert (Boss, or OL for non-admin targets) / inc_update; src/lib/incentivesApi.js:1023-1059 savePlan -->

To create a plan, open **Incentives**, choose the person's tab and click **Create Plan**.

## How to set up a plan
1. Check the banner: person, role and month. The **Brands ... manage** panel lists their brands and tiers.
2. If the person had a plan before, it is pre-filled from their previous month ("Targets and amounts carried over; progress reset"). With no prior plan, **Load default** loads the saved default template.
3. **Basic / Fixed Salary** is locked (**Boss-managed**); it is changed under Boss → Salaries.
4. In **Incentives** and **Bonuses**, add lines under each brand (**Add incentive for ...**) or under **Other** (**Add other incentive**) for things not tied to a brand, such as attendance.
5. For each line fill the description, **Target value** (optional unit such as %, $, pts) and **Compensation if achieved** (PKR).
6. Choose where **Achieved** comes from:
   - **Manual entry** (the person types it),
   - **Auto — monthly attendance %** (target fixed at 100%),
   - **Auto — OL brand roll-up %** (target defaults to 70%),
   - **Auto — brand's GMV in Brand Analytics** (brand lines),
   - **Commission Based Tier — % of GMV above a benchmark** (brand lines): enter **GMV Benchmark** (blank = pay on everything), **Achieved** and **Commission** %. The live sum below shows what it pays, converted to PKR at the rate the Boss sets in Settings.
7. Check the **Summary** (Basic Salary, Total Incentives, Total Bonuses, **Total Salary**) and click **Save**. **Cancel** or **Back** leaves without saving.

## Rules & gotchas
- A GMV-Max line's target is locked to the brand's monthly GMV goal from Brand Analytics when one is set; everyone on that brand shares it.
- Commission over 100% is saved as 100%. The form warns if other people already have commission lines on the same brand this month.
- Lines linked to a brand the person no longer has show in an amber box; remove them or they drop on the next carry-forward.
- **Save as default template** (Boss/OL) overwrites the single shared template. Commission lines are not loaded from the template.
- Verification and payouts are done on the Incentives page, not here.

## Related pages
- Incentives (`/incentives`): lists plans, verification and payouts.
- Brand analytics (`/analytics/brands`): brand GMV goals used by GMV-Max targets.
- Salaries (`/boss/salaries`): where basic salary is changed (Boss).
