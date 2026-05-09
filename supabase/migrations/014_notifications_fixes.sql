-- ============================================================
-- WurxOS v2 — Migration 014: notifications robustness + fan-out fix
--
-- 1. Make the push-dispatch trigger fail-safe: any error inside it
--    (pg_net not installed, bad URL, timeout, etc.) must NOT roll
--    back the underlying notifications INSERT. In-app delivery
--    must always succeed.
--
-- 2. Extend task status-change notification so the **assignee** is
--    also notified when someone else changes the status of a task
--    assigned to them (v1 behaviour). Previously only the creator
--    was notified.
--
-- Safe to re-run.
-- ============================================================

-- --------------------------------------------------------------
-- 1. Fail-safe push dispatch
-- --------------------------------------------------------------
create or replace function public.notifications_dispatch_push()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url    text;
  v_secret text;
begin
  begin
    select value into v_url    from public.app_config where key = 'send_push_url';
    select value into v_secret from public.app_config where key = 'send_push_secret';

    if v_url is null or v_url = '' then
      return new;  -- not configured — silently skip
    end if;

    perform net.http_post(
      url     := v_url,
      headers := jsonb_build_object(
        'Content-Type',    'application/json',
        'x-webhook-secret', coalesce(v_secret, '')
      ),
      body    := jsonb_build_object('notification_id', new.id)
    );
  exception when others then
    -- Swallow any error: push dispatch must never block in-app delivery.
    raise warning 'notifications_dispatch_push failed: %', sqlerrm;
  end;
  return new;
end;
$$;

-- --------------------------------------------------------------
-- 2. Task update notifier — also notify assignee on status change
-- --------------------------------------------------------------
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
  v_actor_name := coalesce(public.profile_display_name(v_actor), 'Someone');

  -- Reassignment — notify new + old assignee
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

  -- Status changed — notify creator (if not actor) AND assignee (if not actor)
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
