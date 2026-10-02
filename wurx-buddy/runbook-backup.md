# Runbook: the weekly database backup

_Engineer 2, 2026-10-02 (mig 410, edge function `db-backup`). Built and proven on
dev; the Lead deploys it to production._

## What runs, and when

| | |
|---|---|
| Edge function | `db-backup` (deploy with `--no-verify-jwt`; secret `AI_INGEST_SECRET`, the same one `ai-ingest` and `tts-crawl` use) |
| Start | pg_cron `db-backup-start`, **Sunday 02:00 GMT = 07:00 PKT** (clear of the Saturday-night TikTok crawl) |
| Continue | pg_cron `db-backup-tick`, every minute, but only while a run is unfinished |
| Destination | the **private** storage bucket `db-backups`, folder `YYYY-MM-DD` (PKT) |
| History | `public.backup_runs` (one row per run), readable by the Boss and active developers |
| Settings | `public.backup_config`: `backup_enabled`, `backup_exclude`, `backup_keep_weeks` (default 8) |
| Manual run | `select public.run_db_backup();` as the Boss or an active developer |

The bucket is private and has **no** storage policy, so only the service role can
read it. A backup contains salaries, performance notes and personal data: never
make the bucket public, and never hand out a signed URL beyond the Boss.

## What a backup contains

- One file per table: `<table>.ndjson.gz` — gzipped NDJSON, one JSON object per
  row, in primary-key order. A table too large for a single slice is split:
  `<table>.ndjson.gz`, `<table>.part01.ndjson.gz`, `part02`… **Concatenate the
  parts in that order** to get the whole table.
- A table with no rows gets no file; it is still listed in the manifest with `rows: 0`.
- `manifest.json`: the table list with row counts, bytes and part names, the
  totals, the database name, the schema version (the highest applied migration),
  the exclude list and the timestamps.

**Everything operational is included**: reports, attendance, leave, incentives,
salaries (`employee_compensation`, `salary_history`), performance, brands, brand
assignments, profiles, the knowledge base, agenda, broadcasts, tasks, GMV Max,
client access, notifications, Buddy's conversations and config.

**Deliberately not included** (`backup_config.backup_exclude`):
`ai_chunks`, `ai_documents`, `ai_ingest_queue`, `ai_ingest_runs`,
`ai_crawl_items`, `ai_crawl_records`, `ai_crawl_state`, `ai_vector_state`,
`tts_articles`, `tts_knowledge`, `ai_model_catalog`.

That is the ingestion and vector store. It is **derived data**: it is rebuilt
from the tables that are backed up, plus a fresh TikTok crawl, and it is both the
largest part of the database and the cheapest to recreate. Restoring it is never
necessary; see "After a restore" below.

## Deploying it (the Lead)

```powershell
# 1. the function (production; the secret already exists there)
supabase functions deploy db-backup --project-ref <prod-ref> --no-verify-jwt

# 2. the migration
#    (409 and below must already be applied to that project)
supabase migration up --project-ref <prod-ref>      # or the project's usual path

# 3. point the cron jobs at the deployed function (SQL editor, production)
update public.app_config set value = 'https://<prod-ref>.supabase.co/functions/v1/db-backup'
 where key = 'backup_url';
```

`backup_url` is inserted empty, so until step 3 both cron jobs are a no-op and
nothing runs. Check it worked:

```sql
select public.run_db_backup();                       -- opens a run and kicks the worker
select id, status, path, rows, bytes, finished_at, last_error
  from public.backup_runs order by started_at desc limit 5;
```

A healthy run reaches `status = 'done'` within a few minutes (production is tens
of MB, so expect several `partial` slices first, one per minute).

## Checking a backup

```sql
select id, started_at, finished_at, status, path, rows, bytes, jsonb_array_length(tables) as tables
  from public.backup_runs order by started_at desc limit 8;
```

Then in the dashboard: **Storage → db-backups → `<YYYY-MM-DD>`**. Open
`manifest.json` and compare a few row counts with the live tables.

## Restoring

Nothing restores automatically. These are deliberate, manual steps.

### One table

1. Download the file(s) for that table from the day's folder.
2. Unzip and concatenate the parts, in order:
   ```bash
   gunzip -c reports.ndjson.gz reports.part01.ndjson.gz > reports.ndjson
   ```
3. Load it into a staging table, then move the rows you need:
   ```sql
   create table restore_reports (j jsonb);
   -- \copy restore_reports (j) from 'reports.ndjson'      -- psql, one JSON object per line
   insert into public.reports
   select * from jsonb_populate_recordset(null::public.reports, (select jsonb_agg(j) from restore_reports))
   on conflict (id) do nothing;          -- or `do update set …` to overwrite
   drop table restore_reports;
   ```
   `jsonb_populate_recordset` maps the columns by name, so a column added after
   the backup simply takes its default.
4. Check the count, then tell whoever reported the loss.

### Everything

Restore into an **empty** database (a fresh project or a wiped one), never on top
of live rows.

1. Apply the migrations up to the manifest's `schema_version`, so the tables and
   constraints match the backup.
2. Load the tables in dependency order — parents before children, because the
   foreign keys are live:
   `profiles` → `brands` → `brand_assignments` → everything else. If an order is
   hard to find, load inside one transaction with
   `set constraints all deferred;`, or temporarily
   `alter table <t> disable trigger all;` (re-enable it immediately afterwards).
3. `auth.users` is **not** in the backup: it belongs to Supabase Auth, not to
   `public`. Recreate the accounts with the `create-user` function (it keeps
   `profiles.id` in step with the auth id), or restore them from Supabase's own
   backup of the `auth` schema.
4. Fix the sequences, or every insert will collide:
   ```sql
   select setval(pg_get_serial_sequence('public.backup_runs', 'id'), coalesce(max(id), 1)) from public.backup_runs;
   ```
   (repeat for each table with a `bigserial`/`serial` key)
5. Re-point `app_config` (`ai_ingest_url`, `ai_crawl_url`, `backup_url`,
   `send_push_url`) at the restored project, and set the function secrets again.

### After a restore: rebuild the vector store

The assistant's search index is not in the backup. Rebuild it:

```sql
select public.ai_backfill(null);     -- enqueue every source type
select public.ai_crawl_start();      -- the TikTok Academy crawl (optional, ~1 h)
```

Then let the ingest worker drain the queue (`ai_ingest_tick` runs every minute),
or run it from the project home: `node scripts/ingest.mjs --drain`. Check
progress with `select public.ai_ingest_stats();` — `vector_pending` reaching 0
means every chunk is searchable.

## Retention

A successful run deletes the day folders older than `backup_keep_weeks` (default
8). To keep more:

```sql
update public.backup_config set backup_keep_weeks = 26 where id = 1;
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| No new folder on Sunday | `app_config.backup_url` is empty, or `backup_config.backup_enabled` is false |
| Run stuck at `partial` | The tick only posts while the lease is free; a dead worker's lease expires after 4 minutes and the next tick picks it up. Still stuck → read `backup_runs.last_error` |
| `status = 'failed'` | `last_error` has the reason. The commonest is a missing bucket (re-run migration 410) or an expired service-role key |
| `too_soon` from `run_db_backup()` | A run started less than 6 hours ago. Use `select public.backup_start('force');` then `select public.backup_post('continue');` |
| Needs to stop now | `update public.backup_runs set status = 'failed', finished_at = now() where status in ('running','partial');` |
| Pause the schedule | `select cron.unschedule('db-backup-start');` (leave the tick; it idles) |
