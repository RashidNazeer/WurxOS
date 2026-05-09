-- ============================================================
-- WurxOS v2 — Migration 004: brands + brand assignments
--
-- Creates:
--   * brands table (owned by a TL, optional logo)
--   * brand_assignments join table (many APCs per brand)
--   * brand-logos storage bucket (public read, auth write)
--   * RLS policies:
--       Boss/OL  — full CRUD on all brands
--       TL       — CRUD on brands they own
--       APC      — read-only for brands they're assigned to
--
-- Safe to re-run.
-- ============================================================

-- --------------------------------------------------------------
-- 1. brands table
-- --------------------------------------------------------------
create table if not exists public.brands (
  id           uuid primary key default gen_random_uuid(),
  brand_name   text not null,
  client_name  text not null default '',
  tier         text,
  status       text not null default 'active'
                 check (status in ('active', 'inactive')),
  logo_url     text,
  owner_id     uuid not null references public.profiles(id) on delete restrict,
  created_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists brands_owner_id_idx    on public.brands(owner_id);
create index if not exists brands_status_idx      on public.brands(status);
create index if not exists brands_brand_name_idx  on public.brands(lower(brand_name));

drop trigger if exists brands_touch_updated_at on public.brands;
create trigger brands_touch_updated_at
  before update on public.brands
  for each row execute function public.touch_updated_at();

-- --------------------------------------------------------------
-- 2. brand_assignments (brand ↔ APC)
-- --------------------------------------------------------------
create table if not exists public.brand_assignments (
  brand_id     uuid not null references public.brands(id)   on delete cascade,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  assigned_by  uuid references public.profiles(id) on delete set null,
  assigned_at  timestamptz not null default now(),
  primary key (brand_id, user_id)
);

create index if not exists brand_assignments_user_id_idx on public.brand_assignments(user_id);

-- --------------------------------------------------------------
-- 3. Helper: is the brand visible to the current user?
--    Boss/OL see everything; TL sees what they own; APC sees assigned.
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
    );
$$;
grant execute on function public.can_view_brand(uuid, uuid, uuid) to authenticated;

-- TL/Boss/OL edit permission
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

-- --------------------------------------------------------------
-- 4. RLS — brands
-- --------------------------------------------------------------
alter table public.brands enable row level security;

drop policy if exists "brands_select" on public.brands;
create policy "brands_select"
  on public.brands for select
  using (public.can_view_brand(owner_id, id, auth.uid()));

drop policy if exists "brands_insert" on public.brands;
create policy "brands_insert"
  on public.brands for insert
  with check (public.can_edit_brand(owner_id, auth.uid()));

drop policy if exists "brands_update" on public.brands;
create policy "brands_update"
  on public.brands for update
  using (public.can_edit_brand(owner_id, auth.uid()))
  with check (public.can_edit_brand(owner_id, auth.uid()));

drop policy if exists "brands_delete" on public.brands;
create policy "brands_delete"
  on public.brands for delete
  using (public.can_edit_brand(owner_id, auth.uid()));

-- --------------------------------------------------------------
-- 5. RLS — brand_assignments
-- --------------------------------------------------------------
alter table public.brand_assignments enable row level security;

-- Anyone who can view the brand can see its assignments (so APC lists load)
drop policy if exists "brand_assignments_select" on public.brand_assignments;
create policy "brand_assignments_select"
  on public.brand_assignments for select
  using (
    exists (
      select 1 from public.brands b
      where b.id = brand_assignments.brand_id
        and public.can_view_brand(b.owner_id, b.id, auth.uid())
    )
  );

-- Only those who can edit the brand can add/remove APCs
drop policy if exists "brand_assignments_write" on public.brand_assignments;
create policy "brand_assignments_write"
  on public.brand_assignments for insert
  with check (
    exists (
      select 1 from public.brands b
      where b.id = brand_assignments.brand_id
        and public.can_edit_brand(b.owner_id, auth.uid())
    )
  );

drop policy if exists "brand_assignments_delete" on public.brand_assignments;
create policy "brand_assignments_delete"
  on public.brand_assignments for delete
  using (
    exists (
      select 1 from public.brands b
      where b.id = brand_assignments.brand_id
        and public.can_edit_brand(b.owner_id, auth.uid())
    )
  );

-- --------------------------------------------------------------
-- 6. Storage bucket for brand logos
-- --------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('brand-logos', 'brand-logos', true)
on conflict (id) do nothing;

drop policy if exists "brand_logos_read" on storage.objects;
create policy "brand_logos_read"
  on storage.objects for select
  using (bucket_id = 'brand-logos');

drop policy if exists "brand_logos_insert" on storage.objects;
create policy "brand_logos_insert"
  on storage.objects for insert
  with check (bucket_id = 'brand-logos' and auth.role() = 'authenticated');

drop policy if exists "brand_logos_update" on storage.objects;
create policy "brand_logos_update"
  on storage.objects for update
  using (bucket_id = 'brand-logos' and auth.role() = 'authenticated');

drop policy if exists "brand_logos_delete" on storage.objects;
create policy "brand_logos_delete"
  on storage.objects for delete
  using (bucket_id = 'brand-logos' and auth.role() = 'authenticated');
