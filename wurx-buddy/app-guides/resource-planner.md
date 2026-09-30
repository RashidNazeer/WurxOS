---
slug: resource-planner
title: Resource Planner
route: /boss/resource-planner
roles: [boss]
feature: admin
last_reviewed: null
---
## What this page is for
Plan headcount and brand capacity across the company: how loaded each person and department is, and how many people you will need as new brands come in. Open **Resource Planner** in the sidebar.

## Who can use it
The Boss only. No other role can open the page, read the planner settings or change them.
<!-- source: Owner decision Q6 (REVIEW.md); App.jsx RoleGuard allow="boss"; mig 392 (resource_planner_config policies, get_planner_config, save_planner_config → Boss only) -->

## How to set the planning inputs
1. Open the **Inputs** tab (or **Edit Inputs** on the Overview).
2. Set **Planning Year**, **Planning Quarter**, **Target New Brands / Month**, **Planning Horizon**, **Max Utilization Target (%)**, **Minimum Buffer Headcount** and **Churn Rate Assumption (%)**.
3. Drop-downs save as soon as you pick; number boxes save when you click out of them. "Saving…" then "Saved" appears at the top right.

## How to set role capacity
1. Open **Role Capacity**.
2. For each role enter **Max Brands**, **Max Hours/Week** and optional **Notes**. Each box saves when you click out of it.
3. Utilization is brands held ÷ Max Brands (e.g. 6 brands with Max Brands 5 = 120%). A role with no Max Brands shows "—".

## How to review capacity
- **Overview** — Total Team, Active Brands, Avg Utilization, Depts Needing Hire, plus **Urgent hiring needed** and **Over capacity** alerts (with **View Planner** / **View Capacity** links) and a planning snapshot.
- **Current Team** — every active person with role, department, brand count and utilization. Search, filter by role or department, and sort by Utilization, Brands or Name.
- **Brand Allocation** — a grid of TLs, PCTLs, APCs and IPCs against brands (green = assigned). Switch **Active**, **Paused** or **All** brands.
- **Dept Capacity** — per department headcount, full-time count, brand load, average utilization bar and status: **OK**, **Moderate** (above your utilization target) or **At Capacity** (over 100%).

## How to plan hiring
1. Open **Headcount Planner**.
2. Pick a horizon (1, 2, 3, 6 or 12 months). This also updates the saved Planning Horizon.
3. Drag **What-if extra brands in horizon** to test extra brands; **Reset** clears it. The slider is not saved.
4. Read **Required headcount by department**: HC needed = projected brands ÷ average Max Brands of the department's roles, rounded up, plus the buffer. Gap = available − needed; **URGENT** (short by 2+), **Hire Soon** (short by 1) or **Sufficient**.
5. **Monthly outlook — next 12 months** shows the same for each month; the horizon month is tagged **Horizon**. Set a monthly target in Inputs to get a real forecast.

## Rules & gotchas
- Only the inputs and role capacity are saved; everything else is calculated live from current staff and brands. Click **Refresh** to reload.
- Operation Leads and the Boss count every active brand as their load; TLs/PCTLs count brands they own; APCs/IPCs count brands assigned to them.
- Developers are not included in the planner. Inactive staff are excluded from the tables.
- Brands that are not active count as "Paused".

## Related pages
- Team Hierarchy (`/team-hierarchy`) — who reports to whom and holds which brands.
- Employees (`/boss/manage/tls`) — add staff when the planner says to hire.
