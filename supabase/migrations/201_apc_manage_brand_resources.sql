-- ============================================================
-- WurxOS v2 — Migration 201: assigned APCs fully manage their
-- brand's resources (main + agenda), regardless of who created them.
--
-- Before: resources.update/delete and agenda_resources.update/delete
-- allowed only the creator, Boss/OL/Developer, or the brand OWNER
-- (can_edit_brand — a TL). An APC could edit/delete only resources
-- they created themselves, not ones a TL added for their brand.
--
-- After: any user ASSIGNED to the resource's brand (brand_assignments
-- — i.e. the working APC/IPC) may also update/delete it. SELECT already
-- includes assigned APCs via can_view_brand, and INSERT is created_by=self,
-- so add (create) and view already worked; only edit/delete were blocked.
--
-- Idempotent.
-- ============================================================

-- ── Main resources ────────────────────────────────────────────
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
    or (brand_id is not null and exists (
      select 1 from public.brand_assignments ba
      where ba.brand_id = resources.brand_id and ba.user_id = auth.uid()
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
    or (brand_id is not null and exists (
      select 1 from public.brand_assignments ba
      where ba.brand_id = resources.brand_id and ba.user_id = auth.uid()
    ))
  );

-- ── Agenda resources ──────────────────────────────────────────
drop policy if exists "agenda_resources_update" on public.agenda_resources;
create policy "agenda_resources_update"
  on public.agenda_resources for update
  using (
    created_by = auth.uid()
    or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p
               where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
    or (brand_id is not null and exists (
      select 1 from public.brands b
      where b.id = agenda_resources.brand_id and public.can_edit_brand(b.owner_id, auth.uid())
    ))
    or (brand_id is not null and exists (
      select 1 from public.brand_assignments ba
      where ba.brand_id = agenda_resources.brand_id and ba.user_id = auth.uid()
    ))
  );

drop policy if exists "agenda_resources_delete" on public.agenda_resources;
create policy "agenda_resources_delete"
  on public.agenda_resources for delete
  using (
    created_by = auth.uid()
    or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p
               where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
    or (brand_id is not null and exists (
      select 1 from public.brands b
      where b.id = agenda_resources.brand_id and public.can_edit_brand(b.owner_id, auth.uid())
    ))
    or (brand_id is not null and exists (
      select 1 from public.brand_assignments ba
      where ba.brand_id = agenda_resources.brand_id and ba.user_id = auth.uid()
    ))
  );
