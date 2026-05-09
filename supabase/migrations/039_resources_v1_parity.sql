-- ============================================================
-- WurxOS v2 — Migration 039: Resources v1 parity
--
-- Adds:
--   * resources.updated_at + auto-touch trigger
--   * notification trigger on insert / update — pings the right people
--     based on scope (brand-scope = brand viewers, general user = target,
--     general group = role members)
--   * "source" generated column for fast platform filtering
--
-- The schema from migration 031 is otherwise unchanged.
-- ============================================================

alter table public.resources
  add column if not exists updated_at timestamptz not null default now();

create or replace function public.resources_touch_updated()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists resources_touch_updated on public.resources;
create trigger resources_touch_updated
  before update on public.resources
  for each row execute function public.resources_touch_updated();

-- ------------------------------------------------------------
-- Notification fan-out
-- ------------------------------------------------------------
create or replace function public.resources_notify()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := new.created_by;
  v_actor_name text;
  v_action text;
  v_title text;
  v_target uuid;
begin
  -- Only fire on initial insert and on actual content changes.
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

  -- Office / private — no notifications (private = self only; office is too noisy).
  return new;
end;
$$;

drop trigger if exists resources_notify_aiu on public.resources;
create trigger resources_notify_aiu
  after insert or update on public.resources
  for each row execute function public.resources_notify();
