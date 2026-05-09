-- ============================================================
-- WurxOS v2 — Migration 011: notifications (in-app)
--
-- Creates:
--   * notifications table (+ RLS: recipients see own only)
--   * helper: public.emit_notification()
--   * triggers on tasks to emit notifications for key events
--     - created        → notify assignee (if ≠ creator)
--     - reassigned     → notify new assignee (if ≠ actor) + old assignee
--     - status_changed → notify creator (if ≠ actor)
--   * enables Realtime on the notifications table
--
-- Push delivery (web-push + service worker) lives in a later
-- migration / Edge Function pair — this migration is in-app only.
--
-- Safe to re-run.
-- ============================================================

-- --------------------------------------------------------------
-- 1. notifications table
-- --------------------------------------------------------------
create table if not exists public.notifications (
  id           uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  actor_id     uuid references public.profiles(id) on delete set null,

  -- Broad bucket for sidebar dots. Add values as features ship:
  --   'task', 'brand', 'report', 'paid_collab', 'system'
  category     text not null,

  -- Specific event for routing + display logic (e.g. 'task.created',
  -- 'task.reassigned', 'task.status_changed')
  action       text not null,

  title        text not null,
  body         text,

  -- Polymorphic pointer to the resource the notification is about.
  entity_type  text,
  entity_id    uuid,

  -- The in-app path to navigate to on click.
  link         text,

  read_at      timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists notifications_recipient_unread_idx
  on public.notifications(recipient_id, created_at desc)
  where read_at is null;
create index if not exists notifications_recipient_idx
  on public.notifications(recipient_id, created_at desc);
create index if not exists notifications_category_idx
  on public.notifications(recipient_id, category)
  where read_at is null;

-- --------------------------------------------------------------
-- 2. RLS — recipients see/update their own only
-- --------------------------------------------------------------
alter table public.notifications enable row level security;

drop policy if exists "notifications_select_own" on public.notifications;
create policy "notifications_select_own"
  on public.notifications for select
  using (auth.uid() = recipient_id);

-- Only the recipient can mark as read (update read_at)
drop policy if exists "notifications_update_own" on public.notifications;
create policy "notifications_update_own"
  on public.notifications for update
  using (auth.uid() = recipient_id)
  with check (auth.uid() = recipient_id);

-- Inserts happen via SECURITY DEFINER helper below; block direct client insert.
drop policy if exists "notifications_insert_block" on public.notifications;
create policy "notifications_insert_block"
  on public.notifications for insert
  with check (false);

-- Delete own (used by "clear all read")
drop policy if exists "notifications_delete_own" on public.notifications;
create policy "notifications_delete_own"
  on public.notifications for delete
  using (auth.uid() = recipient_id);

-- --------------------------------------------------------------
-- 3. Emit helper — bypasses RLS, idempotent via distinct event
-- --------------------------------------------------------------
create or replace function public.emit_notification(
  p_recipient_id uuid,
  p_actor_id     uuid,
  p_category     text,
  p_action       text,
  p_title        text,
  p_body         text,
  p_entity_type  text,
  p_entity_id    uuid,
  p_link         text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  -- Don't notify yourself about your own actions
  if p_recipient_id = p_actor_id then return null; end if;
  if p_recipient_id is null then return null; end if;

  insert into public.notifications (
    recipient_id, actor_id, category, action, title, body,
    entity_type, entity_id, link
  ) values (
    p_recipient_id, p_actor_id, p_category, p_action, p_title, p_body,
    p_entity_type, p_entity_id, p_link
  )
  returning id into v_id;
  return v_id;
end;
$$;

-- --------------------------------------------------------------
-- 4. Triggers on tasks to emit notifications for key events
-- --------------------------------------------------------------

-- Helper to grab the display_name of a profile (fallback to email local part)
create or replace function public.profile_display_name(uid uuid)
returns text
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(display_name, split_part(email, '@', 1), 'Someone')
  from public.profiles where id = uid;
$$;

-- INSERT — task created
create or replace function public.tasks_notify_on_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_name text;
begin
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

drop trigger if exists tasks_notify_ai on public.tasks;
create trigger tasks_notify_ai
  after insert on public.tasks
  for each row execute function public.tasks_notify_on_insert();

-- UPDATE — reassignment + status change
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

  -- Reassignment — notify new assignee + old assignee (if different)
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

  -- Status changed — notify creator if actor isn't them
  if old.status is distinct from new.status then
    if new.created_by is not null and new.created_by <> v_actor then
      perform public.emit_notification(
        new.created_by, v_actor, 'task', 'task.status_changed',
        'Task ' || replace(new.status, '_', ' '),
        v_actor_name || ' marked "' || new.title || '" as ' || replace(new.status, '_', ' '),
        'task', new.id, '/tasks'
      );
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists tasks_notify_au on public.tasks;
create trigger tasks_notify_au
  after update of assignee_id, status on public.tasks
  for each row execute function public.tasks_notify_on_update();

-- --------------------------------------------------------------
-- 5. Realtime — add table to the supabase_realtime publication so
--    the frontend can subscribe to INSERT events.
-- --------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications'
    ) then
      execute 'alter publication supabase_realtime add table public.notifications';
    end if;
  end if;
end;
$$;
