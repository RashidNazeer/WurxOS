-- ============================================================
-- WurxOS v2 — Migration 411: point app_config.backup_url at this project.
--
-- 410 creates the key but cannot know the project ref. ai_ingest_url is already
-- set per environment (deploy-dev-config.mjs on dev, the same step on prod), and
-- db-backup lives beside ai-ingest, so derive it instead of hardcoding a ref.
-- Idempotent, and leaves a URL that is already set alone.
-- ============================================================
update public.app_config
   set value = replace((select value from public.app_config where key = 'ai_ingest_url'), '/ai-ingest', '/db-backup')
 where key = 'backup_url'
   and coalesce(value, '') = ''
   and coalesce((select value from public.app_config where key = 'ai_ingest_url'), '') <> '';

insert into public.app_config (key, value)
select 'backup_url', replace(value, '/ai-ingest', '/db-backup')
  from public.app_config where key = 'ai_ingest_url' and coalesce(value, '') <> ''
on conflict (key) do nothing;
