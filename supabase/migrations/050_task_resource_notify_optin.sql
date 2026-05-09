-- ============================================================
-- WurxOS v2 — Migration 050: opt-in notifications for tasks + resources
--
-- Same pattern as brand switch (migration 048): notifications are
-- off by default. The caller ticks a UI checkbox, which flips a
-- `notify` column on the row being written; the AFTER trigger
-- checks that column before calling emit_notification.
--
-- Tables touched:
--   * tasks      — the insert + update triggers
--   * resources  — the insert/update notify trigger
--
-- Safe to re-run: alter-column adds are guarded by `if not exists`
-- and the functions use create-or-replace.
-- ============================================================

-- --------------------------------------------------------------
-- 1. Transient `notify` flag on each table
--    Default false = silent. Client writes `notify = true` on the
--    same update/insert when they want recipients to be pinged.
-- --------------------------------------------------------------
alter table public.tasks
  add column if not exists notify boolean not null default false;

alter table public.resources
  add column if not exists notify boolean not null default false;

-- --------------------------------------------------------------
-- 2. Task INSERT notifier — gate on new.notify
-- --------------------------------------------------------------
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

-- --------------------------------------------------------------
-- 3. Task UPDATE notifier — gate on new.notify
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
  if not coalesce(new.notify, false) then return new; end if;

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

  -- Status change — notify creator (if not actor) AND assignee (if not actor)
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

-- --------------------------------------------------------------
-- 4. Resources notifier — gate on new.notify. Same scope rules
--    as migration 039 (brand owner + assigned APCs/IPCs for brand-
--    scoped; target user or role-group for general), only fire
--    when the client explicitly opted in.
-- --------------------------------------------------------------
create or replace function public.resources_notify()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor      uuid := new.created_by;
  v_actor_name text;
  v_action     text;
  v_title      text;
  v_target     uuid;
begin
  if not coalesce(new.notify, false) then return new; end if;

  -- Only fire on initial insert or on meaningful content changes.
  if tg_op = 'UPDATE'
     and new.name = old.name
     and new.url = old.url
     and new.description = old.description
     and new.brand_id is not distinct from old.brand_id
     and new.visibility = old.visibility then
    return new;
  end if;

  v_actor_name := public.profile_display_name(v_actor);
  v_action := case when tg_op = 'INSERT' then 'resource.added' else 'resource.updated' end;
  v_title  := case when tg_op = 'INSERT' then 'New resource' else 'Resource updated' end;

  -- Brand-scoped: notify brand owner + assigned APCs/IPCs (skip the actor).
  if new.brand_id is not null then
    for v_target in
      select b.owner_id
        from public.brands b
       where b.id = new.brand_id
         and b.owner_id is not null and b.owner_id <> v_actor
      union
      select ba.user_id
        from public.brand_assignments ba
       where ba.brand_id = new.brand_id
         and ba.user_id <> v_actor
    loop
      perform public.emit_notification(
        v_target, v_actor, 'resource', v_action,
        v_title, v_actor_name || ': ' || left(new.name, 140),
        'resource', new.id, '/resources'
      );
    end loop;
    return new;
  end if;

  -- General · user-scoped: notify only the target user.
  if new.visibility = 'user' and new.visible_to_uid is not null and new.visible_to_uid <> v_actor then
    perform public.emit_notification(
      new.visible_to_uid, v_actor, 'resource', v_action,
      v_title, v_actor_name || ': ' || left(new.name, 140),
      'resource', new.id, '/resources'
    );
    return new;
  end if;

  -- General · group-scoped: notify every active user with one of the targeted roles.
  if new.visibility = 'group' and array_length(new.visible_to_roles, 1) > 0 then
    for v_target in
      select p.id from public.profiles p
       where p.is_active = true
         and p.id <> v_actor
         and p.role = any (new.visible_to_roles)
    loop
      perform public.emit_notification(
        v_target, v_actor, 'resource', v_action,
        v_title, v_actor_name || ': ' || left(new.name, 140),
        'resource', new.id, '/resources'
      );
    end loop;
    return new;
  end if;

  -- Office / private — no notifications.
  return new;
end;
$$;
