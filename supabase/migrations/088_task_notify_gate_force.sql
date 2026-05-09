-- ============================================================
-- WurxOS v2 — Migration 088: force the opt-in notify gate on tasks
--
-- Re-asserts the latest gated definitions of the task notification
-- triggers. Earlier migrations (011 / 014 / 050) defined and re-
-- defined these in numeric order; if they were applied out of
-- order through the dashboard SQL editor (common), the un-gated
-- version from 014 may have ended up as the active definition,
-- which is why notifications fire even when the UI's notify
-- checkbox is unchecked.
--
-- This migration is idempotent and is the single source of truth
-- going forward — both functions early-return when new.notify is
-- false, so the client opt-in is honored every time.
-- ============================================================

-- INSERT — task created. Fire only when the inserter ticked notify.
create or replace function public.tasks_notify_on_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_name text;
begin
  if not coalesce(new.notify, false) then return new; end if;
  if new.assignee_id is null or new.assignee_id = new.created_by then
    return new;
  end if;
  v_actor_name := public.profile_display_name(new.created_by);
  perform public.emit_notification(
    new.assignee_id,
    new.created_by,
    'task',
    'task.created',
    'New task assigned',
    v_actor_name || ' assigned you: ' || new.title,
    'task',
    new.id,
    '/tasks'
  );
  return new;
end;
$$;

-- UPDATE — fire only when the editor ticked notify on this update.
create or replace function public.tasks_notify_on_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor       uuid := auth.uid();
  v_actor_name  text;
begin
  if not coalesce(new.notify, false) then return new; end if;

  v_actor_name := coalesce(public.profile_display_name(v_actor), 'Someone');

  -- Reassignment — notify new + old assignee (if not the actor).
  if old.assignee_id is distinct from new.assignee_id then
    if new.assignee_id is not null and new.assignee_id <> v_actor then
      perform public.emit_notification(
        new.assignee_id, v_actor, 'task', 'task.reassigned',
        'Task assigned to you',
        v_actor_name || ' assigned you: ' || new.title,
        'task', new.id, '/tasks'
      );
    end if;
    if old.assignee_id is not null and old.assignee_id <> v_actor then
      perform public.emit_notification(
        old.assignee_id, v_actor, 'task', 'task.reassigned_away',
        'Task moved off your list',
        v_actor_name || ' reassigned: ' || new.title,
        'task', new.id, '/tasks'
      );
    end if;
  end if;

  -- Status change — notify creator AND assignee (if not the actor
  -- and not duplicates).
  if old.status is distinct from new.status then
    if new.created_by is not null and new.created_by <> v_actor then
      perform public.emit_notification(
        new.created_by, v_actor, 'task', 'task.status_changed',
        'Task ' || replace(new.status, '_', ' '),
        v_actor_name || ' marked "' || new.title || '" as ' || replace(new.status, '_', ' '),
        'task', new.id, '/tasks'
      );
    end if;
    if new.assignee_id is not null
       and new.assignee_id <> v_actor
       and new.assignee_id is distinct from new.created_by then
      perform public.emit_notification(
        new.assignee_id, v_actor, 'task', 'task.status_changed',
        'Task ' || replace(new.status, '_', ' '),
        v_actor_name || ' marked "' || new.title || '" as ' || replace(new.status, '_', ' '),
        'task', new.id, '/tasks'
      );
    end if;
  end if;

  return new;
end;
$$;

-- Triggers themselves are unchanged — keep the existing AFTER
-- INSERT / AFTER UPDATE bindings. Ensure they exist (idempotent).
drop trigger if exists tasks_notify_ai on public.tasks;
create trigger tasks_notify_ai
  after insert on public.tasks
  for each row execute function public.tasks_notify_on_insert();

drop trigger if exists tasks_notify_au on public.tasks;
create trigger tasks_notify_au
  after update on public.tasks
  for each row execute function public.tasks_notify_on_update();
