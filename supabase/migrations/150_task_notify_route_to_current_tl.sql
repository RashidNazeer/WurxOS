-- ============================================================
-- WurxOS v2 — Migration 150: route task status notifications to the
-- assignee's CURRENT TL, not the historical task creator.
--
-- Background: mig 141 rewrites brand-scoped APC self-assigned tasks
-- so created_by = the APC's TL at the time. When an APC is later
-- reassigned to a different TL (profiles.reports_to flips), the
-- task row's created_by keeps pointing at the OLD TL — so the old
-- TL is the one who gets pinged when the APC changes status. The
-- UI was showing "Notify [old TL name]" for the same reason.
--
-- Fix: when the status changes and the task was created by the
-- assignee's TL (the APC→TL pattern), look up the assignee's
-- CURRENT reports_to and notify that profile instead. If the
-- pattern doesn't apply (boss-created tasks, cross-team work,
-- general tasks where the creator isn't a TL of the assignee),
-- keep the original behavior of notifying created_by.
--
-- Idempotent — replaces the function from mig 088.
-- ============================================================

create or replace function public.tasks_notify_on_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor          uuid := auth.uid();
  v_actor_name     text;
  v_status_target  uuid;
  v_current_tl     uuid;
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

  -- Status change — notify the "creator side" AND the assignee
  -- (if not the actor and not duplicates).
  if old.status is distinct from new.status then
    -- Default: notify the recorded creator (unchanged behavior for
    -- boss-created / cross-team / general tasks).
    v_status_target := new.created_by;

    -- APC→TL routing: if the recorded creator is the assignee's
    -- HISTORICAL TL (set by mig 141 at task-creation time), look up
    -- the assignee's CURRENT TL and ping them instead. This way an
    -- APC reassigned to a new TL pings the new TL, not the old one.
    if new.assignee_id is not null and new.created_by is not null then
      select reports_to into v_current_tl
        from public.profiles
       where id = new.assignee_id;

      if v_current_tl is not null and v_current_tl <> new.created_by then
        -- The assignee's current TL differs from the recorded creator,
        -- which means the assignee was reassigned. Only re-route when
        -- the recorded creator was a "TL-like" role for the assignee
        -- (i.e. they were the assignee's TL at creation time — the
        -- only way mig 141 would have set created_by that way). We
        -- approximate this by checking that the recorded creator's
        -- role is TL-shaped — boss/OL-created tasks have a different
        -- role and shouldn't be re-routed.
        if exists (
          select 1 from public.profiles
           where id = new.created_by
             and role in ('tl', 'pctl')
        ) then
          v_status_target := v_current_tl;
        end if;
      end if;
    end if;

    if v_status_target is not null and v_status_target <> v_actor then
      perform public.emit_notification(
        v_status_target, v_actor, 'task', 'task.status_changed',
        'Task ' || replace(new.status, '_', ' '),
        v_actor_name || ' marked "' || new.title || '" as ' || replace(new.status, '_', ' '),
        'task', new.id, '/tasks'
      );
    end if;
    if new.assignee_id is not null
       and new.assignee_id <> v_actor
       and new.assignee_id is distinct from v_status_target then
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
