-- ============================================================
-- 107 — Allow Boss to insert change requests
--
-- v1 parity (commit 17f17b0): Boss submits via the same flow as
-- everyone else. v2's chg_insert policy whitelisted only
-- ('tl','ol','pctl','apc','ipc') — adds 'boss' (and 'developer'
-- for completeness, since they already have admin powers).
--
-- Boss-submitted requests come in already approved — the API sets
-- status='approved' + approved_by/approved_at. RLS still requires
-- submitted_by = auth.uid() so this isn't an escalation vector.
-- ============================================================

drop policy if exists "chg_insert" on public.changes;
create policy "chg_insert" on public.changes for insert
  with check (
    submitted_by = auth.uid()
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.is_active = true
        and p.role in ('boss','tl','ol','pctl','apc','ipc','developer')
    )
  );
