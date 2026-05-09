-- ============================================================
-- 104 — Brand Report Sections: per-brand custom long-form sections
-- that auto-appear in every weekly / bi-weekly report for the
-- brand. Distinct from brand_report_resources (links): these are
-- text fields whose VALUE is per-report (filled by the author
-- in the report form), but whose NAME / template is per-brand.
--
-- Mirrors v1's brandReportSections collection. Stored as a single
-- jsonb sections array per brand (very few sections per brand;
-- management UI rewrites the whole array on each change).
-- ============================================================

create table if not exists public.brand_report_sections (
  brand_id    uuid primary key references public.brands(id) on delete cascade,
  sections    jsonb not null default '[]'::jsonb,
  updated_at  timestamptz not null default now()
);

create index if not exists brand_report_sections_updated_idx
  on public.brand_report_sections(updated_at desc);

-- updated_at refresh
create or replace function public.brand_report_sections_touch_updated()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists brand_report_sections_touch on public.brand_report_sections;
create trigger brand_report_sections_touch
  before update on public.brand_report_sections
  for each row execute function public.brand_report_sections_touch_updated();

alter table public.brand_report_sections enable row level security;

drop policy if exists "brs_select" on public.brand_report_sections;
create policy "brs_select"
  on public.brand_report_sections for select
  using (auth.role() = 'authenticated');

drop policy if exists "brs_insert" on public.brand_report_sections;
create policy "brs_insert"
  on public.brand_report_sections for insert
  with check (auth.role() = 'authenticated');

drop policy if exists "brs_update" on public.brand_report_sections;
create policy "brs_update"
  on public.brand_report_sections for update
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

drop policy if exists "brs_delete" on public.brand_report_sections;
create policy "brs_delete"
  on public.brand_report_sections for delete
  using (auth.role() = 'authenticated');
