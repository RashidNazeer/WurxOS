-- ============================================================
-- WurxOS v2 — Migration 183: Euka → TikTok Shop metrics sync.
--
-- The `euka-sync` edge function calls the Euka MCP server
-- (query_store_data) on a schedule and writes per-store GMV /
-- units / orders snapshots here. WurxOS reads this table for the
-- Shop Metrics dashboard.
--
-- Append-history model: every sync inserts a fresh row per store;
-- the dashboard shows the latest row per store, and the history
-- is kept for future trend charts.
--
-- Idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- 1. brands.euka_store_id — maps a WurxOS brand to its Euka store.
--    The sync auto-fills it on the first name match; an OL can
--    also set it explicitly later.
-- ------------------------------------------------------------
alter table public.brands
  add column if not exists euka_store_id text;

-- ------------------------------------------------------------
-- 2. euka_shop_metrics — per-store metric snapshots
-- ------------------------------------------------------------
create table if not exists public.euka_shop_metrics (
  id            uuid primary key default gen_random_uuid(),
  euka_store_id text not null,
  store_name    text,
  region        text,
  brand_id      uuid references public.brands(id) on delete set null,
  gmv_7d        numeric,
  units_7d      integer,
  orders_7d     integer,
  gmv_30d       numeric,
  units_30d     integer,
  orders_30d    integer,
  currency      text not null default 'USD',
  raw           jsonb,           -- parsed payload + raw summary, kept for safety
  synced_at     timestamptz not null default now()
);

create index if not exists euka_metrics_store_idx
  on public.euka_shop_metrics(euka_store_id, synced_at desc);
create index if not exists euka_metrics_brand_idx
  on public.euka_shop_metrics(brand_id);

alter table public.euka_shop_metrics enable row level security;

-- Read: OL/Boss/Developer see every store; a TL/APC sees only the
-- rows for brands they can already see. Unmapped rows (brand_id
-- null) are OL/Boss-only.
drop policy if exists "euka_metrics_select" on public.euka_shop_metrics;
create policy "euka_metrics_select"
  on public.euka_shop_metrics for select
  using (
    public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p
               where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
    or (brand_id is not null and exists (
      select 1 from public.brands b
      where b.id = euka_shop_metrics.brand_id
        and public.can_view_brand(b.owner_id, b.id, auth.uid())
    ))
  );
-- Writes happen only from the edge function via the service role,
-- which bypasses RLS — so no insert/update policy is defined.

-- ------------------------------------------------------------
-- 3. Realtime — dashboard updates the moment a sync lands
-- ------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise notice 'supabase_realtime publication not present — skipping';
    return;
  end if;
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'euka_shop_metrics'
  ) then
    execute 'alter publication supabase_realtime add table public.euka_shop_metrics';
    raise notice 'Added euka_shop_metrics to supabase_realtime';
  end if;
  execute 'alter table public.euka_shop_metrics replica identity full';
  begin
    execute 'grant select on public.euka_shop_metrics to supabase_realtime_admin';
  exception when undefined_object then
    null;
  end;
end;
$$;

-- ------------------------------------------------------------
-- 4. Schedule the sync — pg_cron POSTs to the euka-sync edge
--    function every 3 hours. The function self-rate-limits, so a
--    duplicate trigger is a harmless no-op.
-- ------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      perform cron.unschedule('euka-sync')
        where exists (select 1 from cron.job where jobname = 'euka-sync');
    exception when others then null;
    end;
    perform cron.schedule(
      'euka-sync',
      '0 */3 * * *',
      $CRON$
        select net.http_post(
          url     := 'https://xoaaidgvblondjpvxjqp.supabase.co/functions/v1/euka-sync',
          headers := '{"Content-Type":"application/json"}'::jsonb,
          body    := '{}'::jsonb
        );
      $CRON$
    );
  end if;
end;
$$;
