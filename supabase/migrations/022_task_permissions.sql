-- ============================================================
-- WurxOS v2 — Migration 022: APC/IPC task-permission gate
--
-- Adds a can_create_tasks(uid) predicate and tightens the tasks
-- INSERT policy so APCs and IPCs only create tasks when their
-- profiles.permissions.canManageTasks flag is true. TL / PCTL /
-- Boss / OL / Developer remain unrestricted.
--
-- Safe to re-run.
-- ============================================================

create or replace function public.can_create_tasks(uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select case
    when p.role in ('boss', 'ol', 'developer', 'tl', 'pctl') then true
    when p.role in ('apc', 'ipc') then
      coalesce((p.permissions ->> 'canManageTasks')::boolean, false)
    else false
  end
  from public.profiles p
  where p.id = uid and p.is_active = true;
$$;
grant execute on function public.can_create_tasks(uuid) to authenticated;

drop policy if exists "tasks_insert" on public.tasks;
create policy "tasks_insert"
  on public.tasks for insert
  with check (
    auth.uid() = created_by
    and (
      -- Personal tasks (no brand, self-assigned) are always allowed.
      (brand_id is null and assignee_id = auth.uid())
      or public.can_create_tasks(auth.uid())
    )
  );
