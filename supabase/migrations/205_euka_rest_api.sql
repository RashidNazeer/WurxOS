-- ============================================================
-- WurxOS v2 — Migration 205: Euka REST API integration.
--
-- Replaces the LLM-mediated Euka MCP sync (mig 183 / euka-sync fn) with the
-- new deterministic Euka REST API (https://api.euka.ai/v0), proxied through
-- the Boss-only `euka-api` edge function.
--
-- 1. Stop the old MCP sync cron (the euka-sync function is retired). The
--    euka_shop_metrics table from mig 183 is LEFT IN PLACE (historical
--    snapshots — no data is dropped), it simply stops being written.
-- 2. Add euka_api_cache — a short-TTL response cache the edge function uses
--    to cap billed Euka API calls. Written/read only by the service role
--    (RLS on, no client policies), so the OpenAPI data never leaks to clients
--    except through the Boss-gated function.
--
-- Idempotent.
-- ============================================================

-- 1. Retire the MCP sync schedule -----------------------------------------
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('euka-sync')
      where exists (select 1 from cron.job where jobname = 'euka-sync');
  end if;
exception when others then
  -- pg_cron not present / already gone — nothing to do.
  null;
end $$;

-- 2. Response cache for the euka-api proxy --------------------------------
create table if not exists public.euka_api_cache (
  cache_key  text primary key,
  payload    jsonb not null,
  fetched_at timestamptz not null default now()
);

create index if not exists euka_api_cache_fetched_idx
  on public.euka_api_cache(fetched_at);

alter table public.euka_api_cache enable row level security;

-- No client policies: only the service-role edge function touches this table,
-- and service role bypasses RLS. Clients get nothing directly.
drop policy if exists "euka_cache_no_client" on public.euka_api_cache;
create policy "euka_cache_no_client" on public.euka_api_cache for all using (false) with check (false);
