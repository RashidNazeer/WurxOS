---
slug: pctl-ipcs
title: IPCs
route: /pctl/ipcs
roles: [boss, ol, pctl]
feature: paid_collab
last_reviewed: null
---
## What this page is for
Manage Influencer Partnership Coordinators (IPCs): add new IPCs, set their leave quota, activate or deactivate them, and choose which brands each IPC works on. Open it from **Paid Collab → IPCs** in the sidebar.

## Who can use it
- **Paid Collab Team Leads (PCTL)** — see only the IPCs who report to them, can add IPCs with **Add IPC**, and can assign only the paid-collab brands they picked on Paid Collab → Brands.
- **Boss and Operation Leads** — see every IPC in the company, with an extra **Manager (PCTL)** column, and can assign any active brand. They do not get the **Add IPC** button (the Boss adds IPCs from Employees → IPCs).

## How to add an IPC (PCTL)
1. Click **Add IPC**.
2. Fill in **Full name** and **Work email**. A **Password** is generated for you; click **Regenerate** for a new one, or type your own (at least 8 characters).
3. Check the **Leave quota (per year)** boxes for WFH, Medical and Emergency. They start at the company defaults.
4. Click **Create IPC**.
5. On the "IPC created" screen, use **Copy credentials** (and **Show/Hide password**) to share the login with the new IPC, then click **Done**.
6. The new IPC automatically reports to you.

## How to assign brands to an IPC
1. Find the IPC (use **Search by name or email…** if needed) and click **Assign Brands** on their row.
2. Under **Brand assignments**, click a brand to assign it (it gets a tick); click again to remove it. If there are more than 8 brands, use **Filter brands…**.
3. Each click is saved immediately — you do not need **Save changes** for brands.

## How to edit an IPC's name, status or leave quota
1. Click **Assign Brands** on the IPC's row.
2. Change **Full name**, set **Status** to **Active** or **Inactive**, or adjust the **Leave quota** numbers.
3. Click **Save changes**. **Cancel** discards these edits (brand changes already made stay saved).

## Rules & gotchas
- A PCTL can only add IPCs if the Boss has given them the "Can add IPCs" permission. Without it, **Create IPC** fails with a "Forbidden" error — ask the Boss.
- A PCTL's brand list only shows brands they picked under Paid Collab → Brands → **Pick workspace brands**. If it is empty, the window tells you to pick brands there first.
- Brands can only be assigned to **active** IPCs, and a PCTL can only change brands for IPCs who report to them.
- An IPC only sees a brand in WurxOS once it is assigned to them here (or by the Boss/brand owner).
- Email cannot be changed from this page.
- Each row shows the IPC's leave quota chips (WFH, Medical, Emergency) and an Active/Inactive badge.
- An IPC's name, active status and leave quota are changed by the Boss or the IPC's own PCTL. Operation Leads change an IPC's brands.
  <!-- source: profiles UPDATE policies: mig 002 profiles_update_self_or_boss, mig 017 profiles_pctl_update_ipcs -->

## Related pages
- Paid Collab — Brands (`/paid-collab/brands`) — pick the brands you can assign (PCTL).
- Employees → IPCs (`/boss/manage/ipcs`) — Boss's full account management, including deleting users.
- Leave (`/leave`) — where IPCs use the quota set here.
