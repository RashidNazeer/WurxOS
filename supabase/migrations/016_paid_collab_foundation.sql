-- ============================================================
-- WurxOS v2 — Migration 016: Paid Collab foundation (M7.1)
--
-- Adds:
--   * brands.paid_collab_status           (text, enum-checked)
--   * profiles.leave_quota                (jsonb: casual/medical/wfh)
--   * pctl_brand_selections               (PCTL-picked brands)
--   * Extended can_view_brand / can_edit_brand for PCTL + IPC
--   * RLS on pctl_brand_selections
--   * Makes IPC assignable via brand_assignments (already open — just doc)
--
-- Safe to re-run.
-- ============================================================

-- --------------------------------------------------------------
-- 1. brands.paid_collab_status
-- --------------------------------------------------------------
alter table public.brands
  add column if not exists paid_collab_status text not null default 'not_applicable';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'brands_paid_collab_status_chk'
  ) then
    alter table public.brands
      add constraint brands_paid_collab_status_chk
      check (paid_collab_status in (
        'managed_by_brand',
        'managed_internally',
        'hybrid',
        'not_applicable'
      ));
  end if;
end;
$$;

create index if not exists brands_paid_collab_status_idx
  on public.brands(paid_collab_status)
  where paid_collab_status <> 'not_applicable';

-- --------------------------------------------------------------
-- 2. profiles.leave_quota  (per-user override; IPC-focused)
--    { wfh: int, medical: int, emergency: int }
--    Default seed mirrors the global defaults below.
-- --------------------------------------------------------------
alter table public.profiles
  add column if not exists leave_quota jsonb not null
  default '{"wfh":2,"medical":1,"emergency":1}'::jsonb;

-- --------------------------------------------------------------
-- 2b. Global leave-quota defaults (Boss-editable from Settings).
--     Stored in app_config under key 'leave_quota_default'.
-- --------------------------------------------------------------
insert into public.app_config(key, value)
values ('leave_quota_default', '{"wfh":2,"medical":1,"emergency":1}')
on conflict (key) do nothing;

-- Boss can read + update app_config (all other clients: denied).
drop policy if exists "app_config_boss_select" on public.app_config;
create policy "app_config_boss_select"
  on public.app_config for select
  using (public.is_boss(auth.uid()));

drop policy if exists "app_config_boss_update" on public.app_config;
create policy "app_config_boss_update"
  on public.app_config for update
  using (public.is_boss(auth.uid()))
  with check (public.is_boss(auth.uid()));

-- --------------------------------------------------------------
-- 3. pctl_brand_selections  (PCTL picks which brands they manage)
-- --------------------------------------------------------------
create table if not exists public.pctl_brand_selections (
  pctl_id     uuid not null references public.profiles(id) on delete cascade,
  brand_id    uuid not null references public.brands(id)   on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (pctl_id, brand_id)
);

create index if not exists pctl_brand_selections_pctl_idx  on public.pctl_brand_selections(pctl_id);
create index if not exists pctl_brand_selections_brand_idx on public.pctl_brand_selections(brand_id);

-- --------------------------------------------------------------
-- 4. Helper: is_pctl(uid)
-- --------------------------------------------------------------
create or replace function public.is_pctl(uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = uid and p.role = 'pctl' and p.is_active = true
  );
$$;
grant execute on function public.is_pctl(uuid) to authenticated;

-- --------------------------------------------------------------
-- 5. Extend can_view_brand so PCTL and IPC see the right brands
--    - PCTL: any brand they've added to pctl_brand_selections
--    - IPC:  any brand in brand_assignments (already handled, but IPCs
--            match the same predicate so no change needed)
-- --------------------------------------------------------------
create or replace function public.can_view_brand(b_owner uuid, b_id uuid, uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select
    public.is_boss(uid)
    or exists (
      select 1 from public.profiles p
      where p.id = uid and p.role in ('ol', 'developer') and p.is_active = true
    )
    or b_owner = uid
    or exists (
      select 1 from public.brand_assignments ba
      where ba.brand_id = b_id and ba.user_id = uid
    )
    or exists (
      select 1 from public.pctl_brand_selections s
      where s.brand_id = b_id and s.pctl_id = uid
    );
$$;
grant execute on function public.can_view_brand(uuid, uuid, uuid) to authenticated;

-- PCTL may also edit brands they've selected (paid-collab side)
create or replace function public.can_edit_brand(b_owner uuid, uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select
    public.is_boss(uid)
    or exists (
      select 1 from public.profiles p
      where p.id = uid and p.role in ('ol', 'developer') and p.is_active = true
    )
    or b_owner = uid;
$$;
grant execute on function public.can_edit_brand(uuid, uuid) to authenticated;
-- (Intentionally not giving PCTL edit on brands — they manage IPC assignments
--  only. Brand edits remain with Boss/OL/TL owner.)

-- --------------------------------------------------------------
-- 6. RLS on pctl_brand_selections
-- --------------------------------------------------------------
alter table public.pctl_brand_selections enable row level security;

drop policy if exists "pctl_brand_selections_select" on public.pctl_brand_selections;
create policy "pctl_brand_selections_select"
  on public.pctl_brand_selections for select
  using (
    auth.uid() = pctl_id
    or public.is_boss(auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true
    )
  );

-- PCTL inserts/deletes their own selections
drop policy if exists "pctl_brand_selections_insert_own" on public.pctl_brand_selections;
create policy "pctl_brand_selections_insert_own"
  on public.pctl_brand_selections for insert
  with check (
    auth.uid() = pctl_id and public.is_pctl(auth.uid())
  );

drop policy if exists "pctl_brand_selections_delete_own" on public.pctl_brand_selections;
create policy "pctl_brand_selections_delete_own"
  on public.pctl_brand_selections for delete
  using (
    auth.uid() = pctl_id
    or public.is_boss(auth.uid())
  );
