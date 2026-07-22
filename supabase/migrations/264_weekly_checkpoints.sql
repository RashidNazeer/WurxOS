-- ============================================================
-- WurxOS v2 — Migration 264: weekly_checkpoints
--
-- Server-side tracking for the Weekly Performance Checkpoint (the Tuesday
-- agenda deck). One row per brand per week; the whole checkpoint lives in
-- `data jsonb`. This replaces the v1 localStorage-only drafts and is the
-- foundation for carry-forward (last week → this week's "previous" columns)
-- and the future auto-fetch phase.
--
-- Safe to re-run.
-- ============================================================

create table if not exists public.weekly_checkpoints (
  id          uuid primary key default gen_random_uuid(),
  brand_id    uuid not null references public.brands(id) on delete cascade,
  week_start  date not null,                    -- Monday of the reviewed week (stable key)
  week_label  text,                             -- display, e.g. "Jul 14–20, 2026"
  data        jsonb not null default '{}'::jsonb,
  status      text not null default 'draft' check (status in ('draft', 'final')),
  author_id   uuid references public.profiles(id),
  updated_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (brand_id, week_start)
);

create index if not exists weekly_checkpoints_brand_week_idx
  on public.weekly_checkpoints(brand_id, week_start desc);

-- ── authz helpers (SECURITY DEFINER, read auth.uid() internally) ──────
-- Write = Boss / OL / dev, the brand's owner TL, or an assigned APC/IPC.
create or replace function public.checkpoint_can_write(p_brand uuid)
returns boolean language sql security definer set search_path = public stable as $$
  select
    public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p
               where p.id = auth.uid() and p.role in ('ol', 'developer') and p.is_active = true)
    or exists (select 1 from public.brands b where b.id = p_brand and b.owner_id = auth.uid())
    or exists (select 1 from public.brand_assignments ba
               where ba.brand_id = p_brand and ba.user_id = auth.uid());
$$;
grant execute on function public.checkpoint_can_write(uuid) to authenticated;

-- View = anyone who can view the brand (Boss/OL/dev, owner TL, assigned users,
-- PCTL selections) — reuses the canonical brand-visibility rule.
create or replace function public.checkpoint_can_view(p_brand uuid)
returns boolean language sql security definer set search_path = public stable as $$
  select public.can_view_brand(
    (select owner_id from public.brands where id = p_brand), p_brand, auth.uid());
$$;
grant execute on function public.checkpoint_can_view(uuid) to authenticated;

-- ── RLS ──────────────────────────────────────────────────────────────
alter table public.weekly_checkpoints enable row level security;

drop policy if exists "weekly_checkpoints_select" on public.weekly_checkpoints;
create policy "weekly_checkpoints_select" on public.weekly_checkpoints
  for select using (public.checkpoint_can_view(brand_id));

drop policy if exists "weekly_checkpoints_insert" on public.weekly_checkpoints;
create policy "weekly_checkpoints_insert" on public.weekly_checkpoints
  for insert with check (public.checkpoint_can_write(brand_id));

drop policy if exists "weekly_checkpoints_update" on public.weekly_checkpoints;
create policy "weekly_checkpoints_update" on public.weekly_checkpoints
  for update using (public.checkpoint_can_write(brand_id))
  with check (public.checkpoint_can_write(brand_id));

drop policy if exists "weekly_checkpoints_delete" on public.weekly_checkpoints;
create policy "weekly_checkpoints_delete" on public.weekly_checkpoints
  for delete using (public.checkpoint_can_write(brand_id));
