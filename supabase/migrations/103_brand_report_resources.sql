-- ============================================================
-- 103 — Brand Report Links: per-brand link sections that
-- auto-render in every weekly / bi-weekly / monthly report.
--
-- Replaces the v1 "brandReportResources" Firestore collection.
-- One row per brand. `sections` is a jsonb array of:
--   { id: string, name: string, links: [{ id, label, url, addedAt }] }
--
-- We keep it in a single jsonb column because there are very few
-- sections per brand (typically 1-3) and the management UI rewrites
-- the whole thing on every edit, so the per-row cost is trivial.
-- ============================================================

create table if not exists public.brand_report_resources (
  brand_id    uuid primary key references public.brands(id) on delete cascade,
  sections    jsonb not null default '[]'::jsonb,
  updated_at  timestamptz not null default now()
);

create index if not exists brand_report_resources_updated_idx
  on public.brand_report_resources(updated_at desc);

-- updated_at refresh trigger
create or replace function public.brand_report_resources_touch_updated()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists brand_report_resources_touch on public.brand_report_resources;
create trigger brand_report_resources_touch
  before update on public.brand_report_resources
  for each row execute function public.brand_report_resources_touch_updated();

-- ============================================================
-- RLS
-- ============================================================
alter table public.brand_report_resources enable row level security;

-- Anyone authenticated can read — same audience as reports themselves.
drop policy if exists "brr_select" on public.brand_report_resources;
create policy "brr_select"
  on public.brand_report_resources for select
  using (auth.role() = 'authenticated');

-- Write: any authenticated user can manage links on a brand they have
-- visibility to. Mirrors the v1 rule "any authed user can manage it".
drop policy if exists "brr_insert" on public.brand_report_resources;
create policy "brr_insert"
  on public.brand_report_resources for insert
  with check (auth.role() = 'authenticated');

drop policy if exists "brr_update" on public.brand_report_resources;
create policy "brr_update"
  on public.brand_report_resources for update
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

drop policy if exists "brr_delete" on public.brand_report_resources;
create policy "brr_delete"
  on public.brand_report_resources for delete
  using (auth.role() = 'authenticated');
