-- ============================================================
-- 162 — Attendance RLS: let APCs/IPCs see their own TL's row
--
-- Context: ClockWidget shows a banner like "Your TL is not clocked
-- in" or "TL auto-clocked-out" so APCs know whether they can reach
-- their manager. That banner is driven by getActiveRecord(ownerId)
-- where ownerId = profile.reports_to (the APC's TL).
--
-- Bug (reported 2026-05-12): APCs always saw "TL not clocked in"
-- even while their TL was actively clocked in. Root cause was the
-- att_select policy from migration 030, which let TLs read their
-- direct reports' attendance but had no symmetric rule for reports
-- reading the TL's row. Read direction was strictly TL → APC.
--
-- Fix: extend att_select so an APC/IPC can read the row of the
-- profile they report to. No new rights for anyone else; the row
-- still doesn't expose payroll data — just clock-in/out times and
-- statuses, which is exactly what the widget already wants.
-- ============================================================

drop policy if exists "att_select" on public.attendance;
create policy "att_select"
  on public.attendance for select
  using (
    auth.uid() = user_id
    or public.is_boss(auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'developer' and p.is_active = true
    )
    or exists (
      -- TL → their direct reports (existing rule from mig 030).
      select 1 from public.profiles p
      where p.id = attendance.user_id and p.reports_to = auth.uid()
    )
    or exists (
      -- NEW: APC/IPC → their own TL. Symmetric to the rule above so
      -- the report can see their manager's clock state.
      select 1 from public.profiles me
      where me.id = auth.uid()
        and me.role in ('apc','ipc')
        and me.reports_to = attendance.user_id
    )
  );
