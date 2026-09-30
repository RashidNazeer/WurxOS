---
slug: resources
title: All Resources
route: /resources
roles: [boss, ol, tl, pctl, apc, ipc, developer, ads_manager]
feature: brands
last_reviewed: null
---
## What this page is for
One place for shared links, images, videos and files: brand resources (tied to a brand) plus general resources (personal or shared with people). Open it from **Resources** in the sidebar.

## Who can use it
Every signed-in role can open the page. It is in the sidebar for Boss, OL, TL and APC; other roles can open it by link.
- You see brand resources for the brands you can see, plus general resources shared with you.
- Who you can share a general resource with depends on your role:
  - **Boss, OL, Developer**: Private, Specific person, Group, Whole office.
  - **TL, PCTL**: Private, Specific person, Group.
  - **APC, IPC, Ads Manager**: Private only.

## How to add a resource
1. Click **Add Resource**.
2. Under **Resource type**, pick **Brand resource** ("Tied to a specific brand") or **General** ("Personal or shared").
3. For a brand resource, choose the **Brand**. For a general resource, choose **Who can see this?**:
   - **Private (only me)**
   - **Specific person** — search and pick one user
   - **Group (select roles)** — tick one or more roles (e.g. Team Leads, APCs)
   - **Whole office (everyone)**
4. Enter the **URL** (required), a **Name** (required) and an optional **Description**. The type (Link, Image, Video, File) is detected from the URL automatically.
5. Leave **Notify brand members** (brand resource) or **Notify the recipient** (specific person) ticked to send a notification, or untick it.
6. Click **Add Resource**.

## How to find a resource
- Use the search box ("Search by name, URL, description…"), the **All Brands** and **All Types** dropdowns, and the **Brand** / **General** scope buttons. **Clear filters** resets them.
- Click a count tile (Links, Images, Videos, Files) to filter by that type.
- Switch between grid and list view with the two icons at the top right.
- Click the URL to open the resource in a new tab.

## How to edit or delete a resource
1. Click the pencil (Edit) or bin (Delete) icon on the resource.
2. When editing you can change the URL, name and description; for general resources you can also change who can see it. Click **Save Changes**.
3. Deleting asks for confirmation and cannot be undone.

You can edit or delete a resource if:
- you created it; or
- you are the Boss; or
- it is a brand resource and you own the brand, are assigned to it, or are an OL.

Another person's **general** resource can be changed only by them or the Boss.
<!-- source: mig 201 res_update / res_delete (creator, boss, can_edit_brand (mig 016, incl. OL) or assigned — brand resources only) -->

## Rules & gotchas
- Private resources are shown only to the person who created them. Boss and OL don't see them on this page.
  <!-- source: AllResourcesPage.jsx:106-110 canUserSeeGeneralResource -->
- Boss and OL can see every non-private general resource.
- Editing a resource never sends a new notification.
- Editing changes a resource's URL, name and description (and, for general resources, who can see it). Its type (brand or general) and its brand stay as they were; to move a resource, delete it and add it again.
  <!-- source: AllResourcesPage.jsx:164-186 handleEdit (patch = name, url, type, description; visibility only for general) -->

## Related pages
- Agenda Resources (`/agenda/resources`) — resources shared in agenda meetings.
- Knowledge Base (`/kb`) — written how-to articles rather than links.
- Brands (`/brands`) — the brand pages resources belong to.
