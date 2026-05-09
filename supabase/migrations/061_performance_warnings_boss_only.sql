-- ============================================================
-- Migration 061 — Warnings are Boss-only (matches v1 rule)
--
-- v1 spec: "Boss only: click "⚠️" button on users → WarnModal".
-- The 032 migration granted write access to any manager that
-- passes can_eval_perf (TLs, OLs, PCTLs). Tighten the
-- performance_warnings write policy so only Boss/Developer can
-- issue warnings. Reads stay broad — the subject should see
-- their own warning count and their manager should too.
-- ============================================================

drop policy if exists "performance_warnings_write" on public.performance_warnings;
create policy "performance_warnings_write"
  on public.performance_warnings for all
  using (
    public.is_boss(auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'developer' and p.is_active = true
    )
  )
  with check (
    public.is_boss(auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'developer' and p.is_active = true
    )
  );
