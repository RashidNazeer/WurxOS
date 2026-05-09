-- ============================================================
-- WurxOS v2 — Migration 017: PCTL-manages-IPC RLS
--
-- Extends two tables so PCTLs can manage their IPCs without the
-- Boss being a bottleneck:
--
--   1. profiles  — PCTL can UPDATE IPCs whose reports_to = them
--   2. brand_assignments — PCTL can INSERT/DELETE rows linking an
--      IPC (reports_to them) to a brand they've selected via
--      pctl_brand_selections.
--
-- Safe to re-run.
-- ============================================================

-- --------------------------------------------------------------
-- 1. profiles — PCTL updates IPCs reporting to them
-- --------------------------------------------------------------
drop policy if exists "profiles_pctl_update_ipcs" on public.profiles;
create policy "profiles_pctl_update_ipcs"
  on public.profiles for update
  using (
    public.is_pctl(auth.uid())
    and role = 'ipc'
    and reports_to = auth.uid()
  )
  with check (
    public.is_pctl(auth.uid())
    and role = 'ipc'
    and reports_to = auth.uid()
  );

-- --------------------------------------------------------------
-- 2. brand_assignments — PCTL writes for IPC × selected brand
-- --------------------------------------------------------------

-- Helper: is user_id an IPC reporting to me, on a brand I've selected?
create or replace function public.pctl_can_assign(
  p_brand_id uuid,
  p_user_id  uuid,
  p_pctl_id  uuid
)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select
    public.is_pctl(p_pctl_id)
    and exists (
      select 1 from public.profiles ipc
      where ipc.id = p_user_id
        and ipc.role = 'ipc'
        and ipc.reports_to = p_pctl_id
        and ipc.is_active = true
    )
    and exists (
      select 1 from public.pctl_brand_selections s
      where s.brand_id = p_brand_id and s.pctl_id = p_pctl_id
    );
$$;
grant execute on function public.pctl_can_assign(uuid, uuid, uuid) to authenticated;

drop policy if exists "brand_assignments_pctl_insert" on public.brand_assignments;
create policy "brand_assignments_pctl_insert"
  on public.brand_assignments for insert
  with check (public.pctl_can_assign(brand_id, user_id, auth.uid()));

drop policy if exists "brand_assignments_pctl_delete" on public.brand_assignments;
create policy "brand_assignments_pctl_delete"
  on public.brand_assignments for delete
  using (public.pctl_can_assign(brand_id, user_id, auth.uid()));
