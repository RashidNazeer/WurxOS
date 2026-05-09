# WurxOS v1 → v2 data migration

Read-only on v1 (Firebase). Writes only to v2 (Supabase). v1 is never touched.

## Setup

1. `firebase-admin-key.json` is here (copied from Downloads). It's gitignored.
2. Supabase service-role key is in `../.env.local` as `SERVICE_ROLL_KEY`.
3. `npm install` — installs firebase-admin and supabase-js.

## Run

```
npm run audit                # counts every v1 collection + v2 table
node run.js <NN>             # dry-run (no writes)
node run.js <NN> --apply     # actually write to Supabase
```

Default is dry-run. `--apply` is required to write.

## Order

00. audit                 (read-only, both sides)
01. auth-users            (Firebase Auth → Supabase Auth, preserves UIDs)
02. profiles              (users + teamUsers → public.profiles)
03. brands
04. attendance
05. kb
06. tasks
07. bugs
08. performance
09. product-campaigns
10. incentives

Skipped per user request: broadcasts.

Each step is idempotent (upsert on Firebase doc ID stored as `legacy_id`),
so re-running is safe.
