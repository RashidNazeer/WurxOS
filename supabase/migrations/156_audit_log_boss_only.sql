-- ============================================================
-- WurxOS v2 — Migration 156: tighten audit_log to Boss-only reads
--
-- The original mig 028 granted SELECT on audit_log to Boss + OL +
-- Developer. That's too wide — the audit log captures every change
-- across brands, tasks, reports, leave_requests, and brand_switch
-- requests for the entire company. Any OL or Developer could read
-- the full change history for every brand they don't manage.
--
-- Tighter rule: only Boss and Developer (for debugging) can read.
-- Take OL out. The Developer role is still admin-tier and explicitly
-- exists to debug production; the original wide grant was probably
-- meant for them, not for OLs.
-- ============================================================

drop policy if exists "audit_select" on public.audit_log;
create policy "audit_select"
  on public.audit_log for select
  using (
    public.is_boss(auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'developer' and p.is_active = true
    )
  );
