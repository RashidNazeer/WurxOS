-- ============================================================
-- WurxOS v2 — Migration 089: TL/PCTL cannot EDIT team incentives
--
-- Tightens RLS so:
--   * SELECT — unchanged: TL/PCTL still see their direct reports'
--     rows so they can monitor team progress.
--   * UPDATE — drops the reports_to-manager clause. Only the row's
--     own user, Boss, OL and developer may UPDATE. TLs can still
--     edit their OWN row (auth.uid() = user_id) but not their team's.
--   * INSERT — already restricted to Boss/OL/developer in 033.
--
-- Net effect: APC/IPC incentives can only be set by OL (or Boss).
-- TLs get a read-only team view, write access on their own row.
-- ============================================================

drop policy if exists "inc_update" on public.incentives;
create policy "inc_update"
  on public.incentives for update
  using (
    auth.uid() = user_id
    or public.is_boss(auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role in ('ol','developer')
        and p.is_active = true
    )
  )
  with check (
    auth.uid() = user_id
    or public.is_boss(auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role in ('ol','developer')
        and p.is_active = true
    )
  );
