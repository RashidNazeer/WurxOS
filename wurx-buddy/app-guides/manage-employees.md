---
slug: manage-employees
title: Employees
route: /boss/manage/tls
roles: [boss]
feature: admin
last_reviewed: null
---
## What this page is for
Where the Boss creates staff accounts, edits them, deactivates them and deletes them. The **Employees** group in the sidebar has one page per role, all working the same way:
- **Affiliate TLs** (`/boss/manage/tls`, page title "Team Leads")
- **Paid Collab TLs** (`/boss/manage/pctls`, "Paid Collab Team Leads")
- **Operation Leads** (`/boss/manage/ols`)
- **APCs** (`/boss/manage/apcs`)
- **IPCs** (`/boss/manage/ipcs`)
- **Ads Managers** (`/boss/manage/ads-managers`)
- **Developers** (`/boss/manage/developers`)

## Who can use it
Only the Boss.

## How to add a user
1. Open the page for the role you want and click **Add …** (for example **Add Team Lead**, **Add APC**).
2. Fill in **Full name** and **Work email**. A **Password** is generated; click **Regenerate** for a new one or type your own (at least 8 characters).
3. **Hire date** defaults to today; change it if needed.
4. For APCs, pick **Reports to (Team Lead)**; for IPCs, pick **Reports to (Paid Collab Team Lead)**. This is required.
5. For Team Leads and Paid Collab Team Leads, turn on any **Permissions** you want to grant:
   - TL: **Can add APCs**, **Can add brands**, **Can manage incentives**.
   - PCTL: **Can add IPCs**, **Can add brands**.
   - APC / IPC: **Can create tasks**.
6. Optionally add **Responsibilities** tags (type one and press Enter or **Add**).
7. Click **Create user**. On the "User created" screen, use **Copy credentials** to share the login, then **Done**.

## How to edit a user
1. Click **Edit** on their row.
2. You can change **Full name**, **Role**, **Reports to**, **Permissions**, **Hire date** and **Responsibilities**.
3. Click **Save changes**.

## How to deactivate or reactivate a user
1. Click **Edit**.
2. Switch **Active account** off (or on). Inactive users can't sign in; their history is kept.
3. Click **Save changes**.

## How to delete a user
1. Click the red bin icon on their row (or use **Delete account** inside **Edit**).
2. Type the user's name exactly as shown to confirm.
3. Click **Delete user** (or **Delete user permanently** inside Edit).

## Rules & gotchas
- Deleting is permanent and cannot be undone. Prefer deactivating if the person may come back or you only want to stop sign-in.
- You cannot delete, deactivate or change the role of yourself or another Boss account.
- Email cannot be changed after creation.
- If no active Team Lead (or PCTL) exists, you must create one before adding an APC (or IPC).
- Changing someone's role moves them to that role's page. Removing a role that needs a manager clears their "Reports to".
- Each row shows the user's "Reports to" person, granted permission badges and up to four responsibility tags.
- Which brands an Ads Manager sees is not set here; an Operation Lead picks them in Settings → Ads Manager Brands.
- Use **Search by name or email…** and the refresh icon to find people and reload the list.

## Related pages
- Salaries (`/boss/salaries`) — pay details; hire date also drives anniversaries there.
- Team Management (`/team-management`) — move an APC to a different Team Lead.
- IPCs (`/pctl/ipcs`) — brand assignments and leave quota for IPCs.
- My team (`/tl/team`) — where a TL with "Can add APCs" onboards their own APCs.
