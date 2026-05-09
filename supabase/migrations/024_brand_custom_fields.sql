-- ============================================================
-- WurxOS v2 — Migration 024: Brand custom fields
--
-- Free-form key/value metadata per brand (e.g. "Launch date",
-- "Commission %", "Target market"). RLS mirrors brands:
--   SELECT — anyone who can view the brand
--   WRITE  — anyone who can edit the brand (Boss/OL/owner TL)
--
-- Safe to re-run.
-- ============================================================

create table if not exists public.brand_custom_fields (
  id          uuid primary key default gen_random_uuid(),
  brand_id    uuid not null references public.brands(id) on delete cascade,
  field_name  text not null check (length(trim(field_name)) > 0),
  field_value text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (brand_id, field_name)
);

create index if not exists brand_custom_fields_brand_idx on public.brand_custom_fields(brand_id);

drop trigger if exists brand_custom_fields_touch on public.brand_custom_fields;
create trigger brand_custom_fields_touch
  before update on public.brand_custom_fields
  for each row execute function public.touch_updated_at();

alter table public.brand_custom_fields enable row level security;

drop policy if exists "bcf_select" on public.brand_custom_fields;
create policy "bcf_select"
  on public.brand_custom_fields for select
  using (
    exists (
      select 1 from public.brands b
      where b.id = brand_custom_fields.brand_id
        and public.can_view_brand(b.owner_id, b.id, auth.uid())
    )
  );

drop policy if exists "bcf_insert" on public.brand_custom_fields;
create policy "bcf_insert"
  on public.brand_custom_fields for insert
  with check (
    exists (
      select 1 from public.brands b
      where b.id = brand_custom_fields.brand_id
        and public.can_edit_brand(b.owner_id, auth.uid())
    )
  );

drop policy if exists "bcf_update" on public.brand_custom_fields;
create policy "bcf_update"
  on public.brand_custom_fields for update
  using (
    exists (
      select 1 from public.brands b
      where b.id = brand_custom_fields.brand_id
        and public.can_edit_brand(b.owner_id, auth.uid())
    )
  );

drop policy if exists "bcf_delete" on public.brand_custom_fields;
create policy "bcf_delete"
  on public.brand_custom_fields for delete
  using (
    exists (
      select 1 from public.brands b
      where b.id = brand_custom_fields.brand_id
        and public.can_edit_brand(b.owner_id, auth.uid())
    )
  );
