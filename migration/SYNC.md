# Ongoing v1 → v2 sync

Until v2 is announced and v1 is decommissioned, data added in v1 needs
to flow into v2. This directory contains an idempotent sync that
re-runs safely as often as you want.

## What it does

For every collection (brands, tasks, reports, attendance, leave,
performance, KB, incentives, campaigns, product campaigns,
suggestions, reminders, bugs, anchors, settings):

1. **Adds new** — v1 docs missing in v2 get inserted.
2. **Updates existing** — v1 docs already in v2 (matched on
   `legacy_id`) get refreshed with the latest field values.
3. **Removes orphans** — v2 rows whose `legacy_id` no longer matches
   any current v1 doc get deleted. Rows with `legacy_id = NULL`
   (v2-native data created since cutover) are NEVER touched.

User accounts: Firebase Auth users that aren't yet in Supabase get
created (with a temp password). v2-only Auth users are not touched.

Notifications collection is intentionally skipped — v2 does its own
notification dispatching.

## Run manually

```
cd a:\Projects\wurxos-v2\migration
node sync-all.js              # dry-run
node sync-all.js --apply      # actually sync
```

## Run on a schedule (recommended)

`sync.bat` is a thin wrapper that runs the apply, with daily log
files in `logs/cron-YYYY-MM-DD.log`. Schedule it via Windows Task
Scheduler:

1. Open **Task Scheduler** → **Create Basic Task**
2. Name: `WurxOS v1->v2 sync`
3. Trigger: **Daily**, recur every 1 day, then on the next screen
   tick **"Repeat task every 1 hour for a duration of 1 day"**
4. Action: **Start a program**
   - Program/script: `a:\Projects\wurxos-v2\migration\sync.bat`
   - Start in: `a:\Projects\wurxos-v2\migration`
5. Settings: tick **"Run task as soon as possible after a scheduled
   start is missed"** so a closed laptop catches up next time it's on.

Each run takes ~2 minutes against the current data sizes. A quick
test: run `sync.bat` manually and check that `logs/cron-...log` ends
with `=== sync-all complete ===`.

## Stop syncing (cutover day)

When v2 is announced and v1 is read-only:
1. Disable the scheduled task.
2. (Optional) Drop the `legacy_id` columns later — they're harmless
   to keep, and useful for audits.

## Files

- `sync-all.js` — runs all idempotent steps in order.
- `sync.bat` — Windows scheduled-task wrapper around `sync-all.js`.
- `lib/sync.js` — shared `deleteOrphans()` helper used by every step.
- `steps/01b-...` — non-destructive Auth user catch-up.
- `steps/02..15-...` — idempotent collection sync. Each step:
  computes UUIDv5 from Firestore doc id, writes legacy_id, then
  upserts and deletes orphans.
- Migrations:
  - `110_legacy_id_columns.sql` — adds `legacy_id text` to every
    migrated table plus partial indexes.
  - `111_sync_bypass_helper.sql` — `sync_brands_upsert(jsonb)` RPC
    that bypasses the brands_block_owner_change trigger when called
    by the service role.

## Adding a new collection later

1. Create `steps/NN-name.js` following the pattern of any existing
   step — include `legacy_id` in each row and call `deleteOrphans`
   after the upsert.
2. Add a `legacy_id text` column to the new table (a migration
   modeled on `110`).
3. Add the step's NN prefix to `STEPS` in `sync-all.js`.
