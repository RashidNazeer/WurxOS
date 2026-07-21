-- ============================================================
-- WurxOS v2 — Migration 260: per-brand, per-month goal tracker.
--
-- Replaces the old aggregate Brand Analytics dashboard with a set of monthly
-- goals per brand, each a target/achieved pair shown as a progress bar. Boss/OL
-- set them each month; the page lets them navigate months.
--
-- Five metrics (each a pair):
--   GMV               goal      vs actual
--   Sample approvals  goal      vs actual
--   Paid Collab       allocated vs used
--   GMV Max           allocated vs used (utilized)
--   ROI               target    vs actual
-- All values are manually entered (nullable = not set).
-- ============================================================

create table if not exists public.brand_monthly_metrics (
  brand_id  uuid not null references public.brands(id) on delete cascade,
  month_key text not null check (month_key ~ '^\d{4}-\d{2}$'),  -- 'YYYY-MM'

  gmv_target             numeric,
  gmv_achieved           numeric,
  samples_target         numeric,
  samples_achieved       numeric,
  paid_collab_allocated  numeric,
  paid_collab_used       numeric,
  gmv_max_allocated      numeric,
  gmv_max_used           numeric,
  roi_target             numeric,
  roi_achieved           numeric,

  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id),
  primary key (brand_id, month_key)
);

-- Access: Boss or an active OL (mirrors the /analytics/brands route guard).
-- Reads auth.uid() internally (no caller-supplied uid oracle — cf. mig 259).
create or replace function public.can_manage_brand_metrics()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select
    public.is_boss(auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'ol' and p.is_active = true
    );
$$;
revoke all on function public.can_manage_brand_metrics() from public, anon;
grant execute on function public.can_manage_brand_metrics() to authenticated;

alter table public.brand_monthly_metrics enable row level security;

drop policy if exists bmm_all on public.brand_monthly_metrics;
create policy bmm_all on public.brand_monthly_metrics
  for all
  using (public.can_manage_brand_metrics())
  with check (public.can_manage_brand_metrics());

grant select, insert, update, delete on public.brand_monthly_metrics to authenticated;
