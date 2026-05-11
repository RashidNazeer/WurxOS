-- ============================================================
-- WurxOS v2 — Migration 149: clear due_date on recurring tasks
--
-- Daily / weekly / monthly tasks reset on their own schedule
-- (see tasksApi.formatResetHint + reset_schedule on profiles),
-- so a due_date on a recurring task makes no sense and was
-- causing them to appear as "overdue" in dashboards and lists.
--
-- One-time cleanup: NULL the due_date for every existing
-- recurring task. Going forward, the Create/Edit task UI hides
-- the due-date field when category != 'general', so this state
-- shouldn't recur.
--
-- Safe to re-run.
-- ============================================================

update public.tasks
set    due_date = null
where  category in ('daily', 'weekly', 'monthly')
  and  due_date is not null;
