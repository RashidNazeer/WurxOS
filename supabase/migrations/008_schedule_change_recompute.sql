-- ============================================================
-- WurxOS v2 — Migration 008: live reset schedule
--
-- When a user saves a new reset_schedule, recompute next_reset_at
-- for every recurring task assigned to them so the change takes
-- effect immediately — without waiting for the next reset cycle.
--
-- Only touches recurring categories (daily/weekly/monthly).
-- General tasks are unaffected (their next_reset_at is always null).
-- Safe to re-run.
-- ============================================================

create or replace function public.recompute_tasks_after_schedule_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only recompute if the schedule actually changed.
  if coalesce(old.reset_schedule::text, '') is distinct from coalesce(new.reset_schedule::text, '') then
    update public.tasks t
    set next_reset_at = public.compute_next_reset(new.id, t.category)
    where t.assignee_id = new.id
      and t.category in ('daily', 'weekly', 'monthly');
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_recompute_task_resets on public.profiles;
create trigger profiles_recompute_task_resets
  after update of reset_schedule on public.profiles
  for each row execute function public.recompute_tasks_after_schedule_change();
