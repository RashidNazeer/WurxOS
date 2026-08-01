-- ============================================================
-- 285 — Creator Library: live sheet connection via a Google Apps Script web app.
--
-- "Publish to web" is a delayed, read-only CSV snapshot (Google regenerates it on
-- a lag). To get INSTANT sync AND to write the Status/Notes columns back into the
-- sheet when an OL/TL approves/rejects, the OS talks to a small Apps Script web
-- app bound to the sheet (runs as the sheet owner). We store its URL + a shared
-- secret here; the creator-sheet edge function reads/writes through it (service
-- role), falling back to the published CSV for reads if no webhook is set.
-- RLS on this table is already boss/ol-only (mig 282), so the secret is safe.
-- ============================================================
alter table public.creator_library_config
  add column if not exists sheet_webhook_url    text,
  add column if not exists sheet_webhook_secret text;
