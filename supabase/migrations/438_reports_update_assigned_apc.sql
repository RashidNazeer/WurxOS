-- ============================================================
-- WurxOS v2 — Migration 438: an assigned APC may edit a DRAFT report on their brand.
--
-- Incident 2026-11-04 (Mineral Ice, October monthly): the TL created the draft, so the
-- brand's APC was neither author nor owner. The UPDATE policy silently matched 0 rows,
-- PostgREST returned success, the app reported "saved" and everything typed was lost.
-- USING limits the new path to drafts; WITH CHECK lets the same save move it on to submitted.
-- ============================================================

drop policy if exists "reports_update" on public.reports;
create policy "reports_update" on public.reports for update
using (
  public.is_boss(auth.uid())
  or exists (select 1 from public.profiles p
              where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active)
  or author_id = auth.uid()
  or exists (select 1 from public.brands b where b.id = reports.brand_id and b.owner_id = auth.uid())
  or (status = 'draft' and exists (select 1 from public.brand_assignments ba
        where ba.brand_id = reports.brand_id and ba.user_id = auth.uid()
          and (ba.expires_at is null or ba.expires_at > now())))
)
with check (
  public.is_boss(auth.uid())
  or exists (select 1 from public.profiles p
              where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active)
  or author_id = auth.uid()
  or exists (select 1 from public.brands b where b.id = reports.brand_id and b.owner_id = auth.uid())
  or exists (select 1 from public.brand_assignments ba
        where ba.brand_id = reports.brand_id and ba.user_id = auth.uid()
          and (ba.expires_at is null or ba.expires_at > now()))
);
