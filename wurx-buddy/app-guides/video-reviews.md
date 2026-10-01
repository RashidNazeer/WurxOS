---
slug: video-reviews
title: Video Reviews
route: /video-reviews
roles: [apc]
feature: brands
last_reviewed: null
---
## What this page is for
Builds the three daily lists of creators who are due their 1st, 2nd or 3rd video review message, as CSV files you can download. Open it from the sidebar: **Video Reviews** (APCs only). At the top, pick how to build the lists: **Euka** (pulled live from Euka) or **TikTok file** (from a TikTok video export you upload). Both are always available.

## Who can use it
Only APCs, and only for brands assigned to them. Every other role is sent back to the dashboard.
- **Euka** mode lists only your brands that are linked to a Euka store. If none are, you see "No Euka brand to run" — ask your Team Lead or the Boss to link the brand to Euka.
- **TikTok file** mode lists your assigned brands. If you have none you see "No brand assigned".

## How to generate lists with Euka
1. **STEP 1 · Choose a brand** (pre-selected if you only have one).
2. **STEP 2 · Target date** — defaults to 3 days ago (Pakistan time), which gives Euka time to finish loading that day. You can't pick a future date.
3. **STEP 3 · Missed run dates** (optional, max 2) — **Add a missed date** for any day you didn't run it; messages due on those days roll forward into this run.
4. **STEP 4 · Exclude creators** (optional) — **Upload exclude list (.csv)** with a single "Handle" column. Those creators are removed from all three files. **Replace** or **Clear** to change it.
5. Click **Generate review files**. Keep the tab open — it can take a minute or two.
6. The three CSVs ("… - 1st/2nd/3rd video review creators.csv") download automatically. Use **CSV** on any row to download again.
7. Check **Needs manual check** for creators the tool couldn't place. **Run for another date** starts over.

## How to generate lists from a TikTok file
1. **STEP 1 · Choose a brand.**
2. **STEP 2 · Upload TikTok video file** (.xlsx / .csv) with **Choose file**. You'll see the number of videos, creators and the date range the file covers; duplicates are counted once and unreadable rows are skipped.
3. **STEP 3 · Sending reviews for** — the day you are sending for (defaults to today, Pakistan time, or to the file's first day if today is outside it). Pick a day inside the file's range.
4. **STEP 4 · Exclude creators** (optional) — same "Handle" CSV as above.
5. Click **Generate review lists**.
6. Click **CSV** on each of **1st video review**, **2nd video review**, **3rd video review** to download it. The button then shows **Sent**.

## Rules & gotchas
- **TikTok file mode: downloading a list marks those creators as sent** and moves them forward in the queue — there is no separate "mark as sent" step. Download only what you will actually send.
- If you closed a CSV by mistake, the **Last messaged on** panel lets you download that day's lists again without re-marking anyone.
- If a run shows **NOTHING DUE**, the page explains why (nobody posted that day, already sent for this day, past their 3rd video, messaged on a later date, or on your exclude list).
- One message per creator per day: creators with several videos get the next message the following day, so run again tomorrow with a fresh file.
- Euka mode does not track what you sent; each run is worked out fresh from Euka.
- Only three review messages are ever sent per creator.

## Related pages
- Brand page (`/brands/:id`) — where a brand gets linked to its Euka store (via **Edit brand**).
- My Brands (`/brands`) — the brands assigned to you.
