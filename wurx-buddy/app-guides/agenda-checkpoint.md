---
slug: agenda-checkpoint
title: Weekly Checkpoint
route: /agenda/checkpoint
roles: [boss, ol, tl, apc, pctl, ipc]
feature: agenda
last_reviewed: null
---
## What this page is for
Build the per-brand weekly checkpoint deck presented at the agenda meeting. It saves as you go and can be exported as a PDF. Open it from **Agenda Meetings → Weekly Checkpoint**.

## Who can use it
- **APC:** creates, edits and submits checkpoints for their brands.
- **Boss and Operation Lead:** can open, edit, submit and delete any checkpoint.
- **Team Lead:** can view checkpoints and generate the PDF; can edit only a checkpoint they created themselves.
- **Paid Collab TL and IPC:** get a different page, **Paid Collab — Weekly Checkpoint**, to fill only the Paid Collab section (see below).
- **Ads Manager:** no access.

## How to create this week's checkpoint (APC)
1. Pick the brand in the dropdown. You only see brands you have access to.
2. The week defaults to **Last week** (the week the meeting reviews). Use the arrows to change it; "report ✓" means a weekly report exists for that week.
3. Click **Create from last week** (copies the previous checkpoint forward; only shown if one exists) or **Start blank**. If a checkpoint already exists, click **Open this week** instead.
4. Wait while it prepares — don't close the window. It auto-fills numbers from your weekly report and, for brands connected to Euka, the target invites and opted-in counts.
5. A banner lists what was filled (e.g. "weekly report ✓ · Euka ✓"). Review those numbers and complete the rest of the sections by hand.
6. Click **Done** to see the deck.

## How to edit and re-fill
1. Open the checkpoint and click **Edit**.
2. Changes save automatically; the top bar shows "Saving…", "Saved" or "Saved locally — will sync".
3. Click **Auto-fill** (shown as **Auto-fill + Euka** for Euka brands) to pull the report and Euka numbers again. If Euka fails, the banner says "Euka unavailable" — your other data is kept.
4. Use the currency box ($, £, €) if the brand isn't in dollars.

## How to submit and export
1. In the deck view, click **Submit**. The status becomes **Submitted**.
2. Click **Generate PDF** to download the deck.
3. **Delete** removes the checkpoint (with a Yes/No confirm).

## How to fill the Paid Collab section (Paid Collab TL / IPC)
1. Pick the week with the arrows (defaults to **Last week**).
2. For each brand on your list, enter Creators onboarded, Creators in pipeline, Videos completed, Videos planned (total), Total budget, Budget allocated and Notes.
3. Click **Save · <week>**. Saving to a week that hasn't finished yet asks you to confirm.
4. Change which brands appear with **Manage brands** (Settings → Paid Collab Brands).

## Rules & gotchas
- Some fields are never auto-filled (e.g. videos now live, sample requests, CTOR, competitors, narrative fields) — fill them yourself.
- For brands handled by the Paid Collab team, section 9 is read-only in the APC's form; use **Remind Paid Collab team** if it's empty.
- If you leave with unsaved edits you'll be asked to save, stay or discard.
- "You are signed in as a different account than this page shows" means another account signed in on another tab — reload before saving.
- There is no TL verify step. After you submit, the status stays **Submitted**, and no one needs to verify it. Your brand's TL just gets a notification that it's ready to view. You can still edit it after submitting.
  <!-- source: Owner decision Q4 (REVIEW.md); mig 305 checkpoint_notify_on_status (submit-only); AgendaCheckpointPage.jsx STATUS_PILL submitted → 'Submitted', button 'Submit'; CheckpointReturnNotice.jsx -->

## Related pages
- Weekly Reports (`/weekly-reports`) — the source of the auto-filled numbers.
- Ongoing Meetings (`/agenda/ongoing`) — where the checkpoint is presented.
- Settings (`/settings`) — Paid Collab Brands list.
