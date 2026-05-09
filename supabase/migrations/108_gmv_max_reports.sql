-- ============================================================
-- 108 — GMV Max Reporting
--
-- Per-brand monthly entries with optional per-campaign breakdown.
-- All monetary fields stored as numeric and assumed USD (the
-- TikTok Ads Manager source for these reports is USD-denominated).
--
-- One row per (brand_id, period_start). period is always 'monthly'
-- in the final v1 design — the weekly cadence was removed in favor
-- of a Campaigns array nested under each monthly entry.
--
-- The campaigns column is a jsonb array of:
--   { id, campaignName, campaignId, targetRoi, scheduleTime,
--     campaignBudget, status, cost, skuOrders, costPerOrder,
--     grossRevenue, roi, notes }
-- ============================================================

create table if not exists public.gmv_max_reports (
  id              uuid primary key default gen_random_uuid(),
  brand_id        uuid not null references public.brands(id) on delete cascade,
  brand_name      text not null,

  period          text not null default 'monthly'
                    check (period in ('monthly', 'weekly')),
  period_start    date not null,
  period_end      date not null,
  period_label    text not null,

  -- Monthly Overview metrics (5 fields, manually entered)
  cost            numeric(14,2) default 0,
  sku_orders      integer default 0,
  cost_per_order  numeric(14,2) default 0,
  gross_revenue   numeric(14,2) default 0,
  roi             numeric(10,4) default 0,

  currency        text not null default 'USD',
  notes           text default '',

  -- Per-campaign breakdown
  campaigns       jsonb not null default '[]'::jsonb,

  created_at      timestamptz not null default now(),
  created_by      uuid references public.profiles(id) on delete set null,
  created_by_name text,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references public.profiles(id) on delete set null,
  updated_by_name text,

  unique (brand_id, period, period_start)
);

create index if not exists gmv_max_reports_brand_idx
  on public.gmv_max_reports(brand_id, period_start desc);
create index if not exists gmv_max_reports_period_idx
  on public.gmv_max_reports(period_start desc);

-- updated_at refresh trigger
create or replace function public.gmv_max_reports_touch_updated()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists gmv_max_reports_touch on public.gmv_max_reports;
create trigger gmv_max_reports_touch
  before update on public.gmv_max_reports
  for each row execute function public.gmv_max_reports_touch_updated();

-- ============================================================
-- RLS
-- ============================================================
alter table public.gmv_max_reports enable row level security;

-- Read: any authenticated user can read all GMV Max entries (same audience
-- as reports). Public read for client share links is handled via a
-- SECURITY DEFINER RPC, not via this policy.
drop policy if exists "gmv_select" on public.gmv_max_reports;
create policy "gmv_select"
  on public.gmv_max_reports for select
  using (auth.role() = 'authenticated');

-- Write: APC, IPC, TL/PCTL, OL, Boss, Developer can write. APCs are
-- expected to enter for their own brands; the brand-level UI restricts
-- them to brands they own/are assigned to. RLS allows any of these
-- roles to write any row — same trust model as reports.
drop policy if exists "gmv_insert" on public.gmv_max_reports;
create policy "gmv_insert"
  on public.gmv_max_reports for insert
  with check (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.is_active = true
        and p.role in ('boss', 'ol', 'tl', 'pctl', 'apc', 'ipc', 'developer')
    )
  );

drop policy if exists "gmv_update" on public.gmv_max_reports;
create policy "gmv_update"
  on public.gmv_max_reports for update
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.is_active = true
        and p.role in ('boss', 'ol', 'tl', 'pctl', 'apc', 'ipc', 'developer')
    )
  )
  with check (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.is_active = true
        and p.role in ('boss', 'ol', 'tl', 'pctl', 'apc', 'ipc', 'developer')
    )
  );

drop policy if exists "gmv_delete" on public.gmv_max_reports;
create policy "gmv_delete"
  on public.gmv_max_reports for delete
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.is_active = true
        and p.role in ('boss', 'ol', 'developer')
    )
  );
