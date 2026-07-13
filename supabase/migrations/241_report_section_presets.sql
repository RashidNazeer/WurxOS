-- ============================================================
-- WurxOS v2 — Migration 241: Report section presets
--
-- Lets a report author SAVE the content of a report section as a reusable
-- named "preset", then RESTORE it into a later report of the same type — so
-- recurring structure (e.g. GMV Max campaign names, the usual top-creator
-- list) doesn't have to be re-typed every period. Works for hardcoded sections
-- AND brand custom sections; structured sections save a chosen subset of
-- fields, long-text sections save the whole formatted content.
--
-- Scope = per BRAND, per REPORT TYPE, per SECTION. Presets are SHARED within a
-- brand (any author of that brand's reports sees them) — the same brand-scoped
-- model as brand_report_sections, so brand knowledge like campaign structures
-- is shared, and crucially can NEVER leak across brands (the past cross-brand
-- section bug must not recur): every row carries brand_id and every read/write
-- filters by it, and RLS enforces it at the DB layer too.
--
-- `section_key`:
--   • hardcoded section  → the report data key ('gmvMax', 'topCreators', …)
--   • custom section     → the section's opaque id ('cs_…') — so deleting a
--     custom section can delete exactly its presets, and a same-NAMED new
--     section (which gets a fresh id) never resurrects them.
--   NOTE: custom sections are not DB rows (they live in a jsonb blob), so the
--   "delete section → delete its presets" rule is enforced in app code
--   (useBrandSections.deleteBrandCustomSection), not by an FK cascade. Only the
--   brand-level delete cascades here (brand_id → brands ON DELETE CASCADE).
--
-- `payload` jsonb shapes:
--   rows:   { kind:'rows',   fields:[key,…], rows:[{key:val,…},…] }
--   object: { kind:'object', fields:[key,…], values:{key:val,…} }
--   text:   { kind:'text',   html:'<p>…</p>' }
--
-- RLS: gated on can_view_brand (NOT can_edit_brand) on purpose — APCs author
-- most reports and can VIEW but not strictly EDIT a brand; they must be able to
-- save/restore presets. can_view_brand covers every report author for a brand.
--
-- Safe to re-run.
-- ============================================================

create table if not exists public.report_section_presets (
  id          uuid primary key default gen_random_uuid(),
  brand_id    uuid not null references public.brands(id) on delete cascade,
  report_type text not null check (report_type in ('weekly', 'biweekly', 'monthly')),
  section_key text not null check (length(trim(section_key)) > 0),
  name        text not null check (length(trim(name)) > 0),
  payload     jsonb not null default '{}'::jsonb,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- Saving under an existing name overwrites it (upsert) rather than duplicating.
  unique (brand_id, report_type, section_key, name)
);

create index if not exists report_section_presets_lookup_idx
  on public.report_section_presets(brand_id, report_type, section_key);

drop trigger if exists report_section_presets_touch on public.report_section_presets;
create trigger report_section_presets_touch
  before update on public.report_section_presets
  for each row execute function public.touch_updated_at();

alter table public.report_section_presets enable row level security;

drop policy if exists "rsp_select" on public.report_section_presets;
create policy "rsp_select"
  on public.report_section_presets for select
  using (
    exists (
      select 1 from public.brands b
      where b.id = report_section_presets.brand_id
        and public.can_view_brand(b.owner_id, b.id, auth.uid())
    )
  );

drop policy if exists "rsp_insert" on public.report_section_presets;
create policy "rsp_insert"
  on public.report_section_presets for insert
  with check (
    exists (
      select 1 from public.brands b
      where b.id = report_section_presets.brand_id
        and public.can_view_brand(b.owner_id, b.id, auth.uid())
    )
  );

drop policy if exists "rsp_update" on public.report_section_presets;
create policy "rsp_update"
  on public.report_section_presets for update
  using (
    exists (
      select 1 from public.brands b
      where b.id = report_section_presets.brand_id
        and public.can_view_brand(b.owner_id, b.id, auth.uid())
    )
  );

drop policy if exists "rsp_delete" on public.report_section_presets;
create policy "rsp_delete"
  on public.report_section_presets for delete
  using (
    exists (
      select 1 from public.brands b
      where b.id = report_section_presets.brand_id
        and public.can_view_brand(b.owner_id, b.id, auth.uid())
    )
  );
