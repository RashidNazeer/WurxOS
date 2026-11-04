-- ============================================================
-- WurxOS v2 — Migration 439: an author (APC) edits a report only while it is a DRAFT.
--
-- Rule: after the APC submits, they cannot edit it again until the TL/OL returns it
-- (a return sets status back to 'draft'). Mig 438 gave the assigned APC the same
-- draft-only access to reports a TL started; the author path was still unrestricted,
-- so an APC could keep editing their own report after submitting. WITH CHECK is
-- unchanged, so the draft -> submitted save itself still passes.
-- ============================================================

drop policy if exists "reports_update" on public.reports;
create policy "reports_update" on public.reports for update
using (
  public.is_boss(auth.uid())
  or exists (select 1 from public.profiles p
              where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active)
  or exists (select 1 from public.brands b where b.id = reports.brand_id and b.owner_id = auth.uid())
  or (status = 'draft' and author_id = auth.uid())
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
