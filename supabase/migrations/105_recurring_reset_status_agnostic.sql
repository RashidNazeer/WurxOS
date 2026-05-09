-- ============================================================
-- 105 — Recurring task reset semantics
--
-- v1 fix + user request: a recurring task should reset whenever
-- next_reset_at fires, regardless of its current status. Previously
-- v2 only reset tasks whose status was 'done', which left tasks
-- stuck in 'todo' or 'in-progress' across period boundaries.
--
-- New behaviour:
--   * status: forced back to 'todo' on every reset (any prior status)
--   * next_reset_at: advanced via compute_next_reset() (unchanged)
--   * due_date: advanced to the day BEFORE the new next_reset_at, so
--               recurring tasks always carry a fresh deadline of "this
--               period's last day". This fixes the v1 bug where a
--               recurring task with a stale due_date appeared overdue
--               immediately after reset.
-- ============================================================

create or replace function public.reset_recurring_tasks()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.tasks t
  set status = 'todo',
      next_reset_at = public.compute_next_reset(t.assignee_id, t.category),
      -- New due_date = day before the next reset boundary.
      -- compute_next_reset() returns the next reset *time*; the period
      -- the task covers ends one day prior. NULL when general / no
      -- schedule is computable.
      due_date = case
        when public.compute_next_reset(t.assignee_id, t.category) is null then t.due_date
        else (public.compute_next_reset(t.assignee_id, t.category) - interval '1 day')::date
      end,
      updated_at = now()
  where t.category in ('daily','weekly','monthly')
    and t.next_reset_at is not null
    and t.next_reset_at <= now();
end;
$$;
