-- ============================================================
-- WurxOS v2 — Migration 031: Resources
--
-- Shared links/images/videos. Either brand-scoped (follows
-- can_view_brand) or general-scoped (with visibility controls).
-- ============================================================

create table if not exists public.resources (
  id                uuid primary key default gen_random_uuid(),
  brand_id          uuid references public.brands(id) on delete cascade,
  type              text not null check (type in ('link','image','video','file')),
  name              text not null,
  url               text not null,
  description       text not null default '',
  visibility        text not null default 'office'
                      check (visibility in ('private','office','user','group')),
  visible_to_uid    uuid references public.profiles(id) on delete set null,
  visible_to_roles  text[] not null default '{}',
  created_by        uuid not null references public.profiles(id) on delete cascade,
  created_at        timestamptz not null default now()
);

create index if not exists resources_brand_idx    on public.resources(brand_id);
create index if not exists resources_creator_idx  on public.resources(created_by);

alter table public.resources enable row level security;

drop policy if exists "res_select" on public.resources;
create policy "res_select"
  on public.resources for select
  using (
    -- Creator / Boss / OL / Developer always
    created_by = auth.uid()
    or public.is_boss(auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true
    )
    -- Brand-scoped: visible to anyone who can see the brand
    or (brand_id is not null and exists (
      select 1 from public.brands b
      where b.id = resources.brand_id
        and public.can_view_brand(b.owner_id, b.id, auth.uid())
    ))
    -- General-scoped visibility
    or (brand_id is null and (
      (visibility = 'office')
      or (visibility = 'user'  and visible_to_uid = auth.uid())
      or (visibility = 'group' and exists (
           select 1 from public.profiles p
           where p.id = auth.uid() and p.role = any (visible_to_roles)
         ))
    ))
  );

drop policy if exists "res_insert" on public.resources;
create policy "res_insert"
  on public.resources for insert
  with check (created_by = auth.uid());

drop policy if exists "res_update" on public.resources;
create policy "res_update"
  on public.resources for update
  using (
    created_by = auth.uid()
    or public.is_boss(auth.uid())
    or (brand_id is not null and exists (
      select 1 from public.brands b
      where b.id = resources.brand_id and public.can_edit_brand(b.owner_id, auth.uid())
    ))
  );

drop policy if exists "res_delete" on public.resources;
create policy "res_delete"
  on public.resources for delete
  using (
    created_by = auth.uid()
    or public.is_boss(auth.uid())
    or (brand_id is not null and exists (
      select 1 from public.brands b
      where b.id = resources.brand_id and public.can_edit_brand(b.owner_id, auth.uid())
    ))
  );
