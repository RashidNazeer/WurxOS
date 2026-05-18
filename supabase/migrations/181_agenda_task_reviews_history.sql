-- ============================================================
-- WurxOS v2 — Migration 181: open task reviews for the Prior
-- Meetings history.
--
-- agenda_task_reviews was OL-only while the live evaluation was
-- being built (mig 179). The Prior Meetings archive now needs:
--   * the reviewed APC to read their OWN task reviews
--   * the team's TL to read their team's task reviews
--   * OL/Boss/Developer unchanged (all)
--
-- Write access stays OL/Boss/Developer only.
--
-- Idempotent.
-- ============================================================

drop policy if exists "agenda_rev_select" on public.agenda_task_reviews;
create policy "agenda_rev_select"
  on public.agenda_task_reviews for select
  using (
    public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p
               where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
    or apc_id = auth.uid()
    or exists (select 1 from public.agenda_meetings m
               where m.id = meeting_id and m.tl_id = auth.uid())
  );
