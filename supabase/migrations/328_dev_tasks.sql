-- ============================================================
-- WurxOS v2 — Migration 328: Developer task management.
--
-- A deliberately SEPARATE system from public.tasks (which is flat,
-- brand-scoped, three statuses, and built for APC/TL daily work) and from
-- Change Management (which is "what should we build", not "what are we
-- building"). Explicitly requested to have no link to either.
--
-- Two levels only: a dev_task ("the pipeline", e.g. Update UI/UX) holding
-- dev_subtasks ("update the dashboard UI"). A third level was considered and
-- rejected — every small job would need a parent invented for it.
--
-- DESIGN NOTES worth keeping:
--
-- * requested_by vs created_by. The Boss or an OL often asks for something
--   verbally and is too busy to log it, so the developer logs it himself and
--   names who wanted it. Recording that person as the creator would be a lie
--   the audit trail then repeats forever. So created_by is who actually made
--   the row (automatic) and requested_by is who wanted it (chosen).
--   requested_confirmed_at lets the named person acknowledge, so the UI can
--   distinguish "the Boss confirmed he asked" from "the developer says so".
--
-- * "Delayed" is NOT a status. It is derived from due_date having passed while
--   the task is unfinished. As a status somebody has to remember to set it,
--   and nobody ever does, so the board would show three-week-late work as
--   healthy. Derived is always correct and costs nobody anything.
--
-- * Blocked and Paused are different and both earn their place. Blocked means
--   someone else is holding it up (usually the Boss); Paused means the
--   developer set it down deliberately. Collapsing them hides the one fact the
--   Boss most needs to see.
--
-- * Cancelled is a status, not a delete. Dropped work is worth remembering,
--   and it must not inflate the progress bar (see the progress view below).
--
-- * RLS names the developer role EXPLICITLY rather than relying on the
--   ambient elevation `developer` still carries in ~20 older policies. That
--   elevation is being removed in stages (mig 212 onward), and a feature
--   leaning on it would break silently when the demotion completes.
-- ============================================================

-- ── Shared enums as CHECKs (matches the codebase convention) ─────────
--   status:   pending | in_progress | blocked | paused | done | cancelled
--   priority: low | medium | high | urgent

create table if not exists public.dev_tasks (
  id           uuid primary key default gen_random_uuid(),
  title        text not null check (length(trim(title)) between 1 and 200),
  description  text,

  status   text not null default 'pending'
             check (status in ('pending','in_progress','blocked','paused','done','cancelled')),
  priority text not null default 'medium'
             check (priority in ('low','medium','high','urgent')),

  due_date date,

  -- Who WANTED it (Boss or an OL). Nullable so a task is never blocked on
  -- picking someone, but the UI asks for it.
  requested_by            uuid references public.profiles(id) on delete set null,
  -- Non-null once that person acknowledges. Null = the developer's own claim.
  requested_confirmed_at  timestamptz,

  -- Who actually created the row. Never chosen by a human.
  created_by  uuid references public.profiles(id) on delete set null,
  assigned_to uuid references public.profiles(id) on delete set null,

  -- Set when the Boss force-closes a task that still has open subtasks. Stops
  -- the auto-rollup below from immediately re-opening it and fighting them.
  completed_override boolean not null default false,

  completed_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists public.dev_subtasks (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references public.dev_tasks(id) on delete cascade,
  title       text not null check (length(trim(title)) between 1 and 200),
  description text,

  status   text not null default 'pending'
             check (status in ('pending','in_progress','blocked','paused','done','cancelled')),
  priority text not null default 'medium'
             check (priority in ('low','medium','high','urgent')),

  due_date date,
  position int  not null default 0,   -- manual ordering within the board column

  completed_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Append-only timeline. A note ALWAYS carries task_id (so one query renders the
-- whole pipeline history) and additionally carries subtask_id when it is about
-- a subtask. status_from/status_to are set when the note accompanies a move.
create table if not exists public.dev_task_notes (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references public.dev_tasks(id) on delete cascade,
  subtask_id  uuid references public.dev_subtasks(id) on delete cascade,
  author_id   uuid references public.profiles(id) on delete set null,
  status_from text,
  status_to   text,
  body        text check (body is null or length(body) <= 4000),
  created_at  timestamptz not null default now(),
  -- A note with neither a body nor a status move carries no information.
  constraint dev_task_notes_not_empty
    check (coalesce(trim(body), '') <> '' or status_to is not null)
);

create index if not exists dev_tasks_status_idx      on public.dev_tasks (status, priority, due_date);
create index if not exists dev_subtasks_task_idx     on public.dev_subtasks (task_id, position);
create index if not exists dev_task_notes_task_idx   on public.dev_task_notes (task_id, created_at desc);

-- ── updated_at ───────────────────────────────────────────────────────
create or replace function public.dev_touch_updated_at()
returns trigger language plpgsql as $fn$
begin new.updated_at := now(); return new; end;
$fn$;

drop trigger if exists dev_tasks_touch on public.dev_tasks;
create trigger dev_tasks_touch before update on public.dev_tasks
  for each row execute function public.dev_touch_updated_at();
drop trigger if exists dev_subtasks_touch on public.dev_subtasks;
create trigger dev_subtasks_touch before update on public.dev_subtasks
  for each row execute function public.dev_touch_updated_at();

-- ── completed_at follows status, on both levels ──────────────────────
create or replace function public.dev_sync_completed_at()
returns trigger language plpgsql as $fn$
begin
  if new.status = 'done' and (tg_op = 'INSERT' or old.status is distinct from 'done') then
    new.completed_at := coalesce(new.completed_at, now());
  elsif new.status <> 'done' then
    new.completed_at := null;
  end if;
  return new;
end;
$fn$;

drop trigger if exists dev_tasks_completed_at on public.dev_tasks;
create trigger dev_tasks_completed_at before insert or update on public.dev_tasks
  for each row execute function public.dev_sync_completed_at();
drop trigger if exists dev_subtasks_completed_at on public.dev_subtasks;
create trigger dev_subtasks_completed_at before insert or update on public.dev_subtasks
  for each row execute function public.dev_sync_completed_at();

-- ── Roll a parent up/down from its subtasks ──────────────────────────
-- Rules agreed:
--   * a task with NO subtasks is completed by hand;
--   * with subtasks, it goes done when every one is done or cancelled;
--   * adding or re-opening a subtask under a done task re-opens the parent,
--     visibly, because otherwise "done" quietly becomes untrue;
--   * completed_override (the Boss force-closing) suspends all of this.
-- Cancelled parents are left alone — cancelling is a decision about the whole
-- pipeline and subtask churn must not resurrect it.
create or replace function public.dev_rollup_parent(p_task uuid)
returns void language plpgsql security definer set search_path = public as $fn$
declare
  v_total    int;
  v_open     int;
  v_task     public.dev_tasks;
begin
  select * into v_task from public.dev_tasks where id = p_task;
  if not found or v_task.completed_override or v_task.status = 'cancelled' then return; end if;

  select count(*), count(*) filter (where status not in ('done','cancelled'))
    into v_total, v_open
  from public.dev_subtasks where task_id = p_task;

  if v_total = 0 then
    return;                                        -- hand-managed
  elsif v_open = 0 and v_task.status <> 'done' then
    update public.dev_tasks set status = 'done' where id = p_task;
  elsif v_open > 0 and v_task.status = 'done' then
    update public.dev_tasks set status = 'in_progress' where id = p_task;
  end if;
end;
$fn$;

create or replace function public.dev_subtask_rollup()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  perform public.dev_rollup_parent(coalesce(new.task_id, old.task_id));
  return null;
end;
$fn$;

drop trigger if exists dev_subtasks_rollup on public.dev_subtasks;
create trigger dev_subtasks_rollup
  after insert or update of status or delete on public.dev_subtasks
  for each row execute function public.dev_subtask_rollup();

-- ── Progress, derived. Never stored. ─────────────────────────────────
-- Cancelled subtasks leave the DENOMINATOR rather than counting as done:
-- cancelling work must not make the bar jump forward.
create or replace view public.dev_tasks_with_progress as
select
  t.*,
  coalesce(s.total, 0)                                as subtask_total,
  coalesce(s.done, 0)                                 as subtask_done,
  coalesce(s.counted, 0)                              as subtask_counted,
  case when coalesce(s.counted, 0) = 0 then null
       else round(100.0 * s.done / s.counted)::int end as progress_pct,
  (t.due_date is not null
     and t.due_date < (now() at time zone 'Asia/Karachi')::date
     and t.status not in ('done','cancelled'))         as is_overdue
from public.dev_tasks t
left join lateral (
  select count(*) as total,
         count(*) filter (where status = 'done')                    as done,
         count(*) filter (where status <> 'cancelled')              as counted
  from public.dev_subtasks d where d.task_id = t.id
) s on true;

-- ── RLS ──────────────────────────────────────────────────────────────
-- Visible to Boss, OL and the developer. Nobody else, including TLs.
create or replace function public.dev_tasks_can_view(uid uuid)
returns boolean language sql security definer set search_path = public stable as $fn$
  select public.is_boss(uid)
      or exists (select 1 from public.profiles p
                 where p.id = uid and p.is_active = true and p.role in ('ol','developer'));
$fn$;

-- Only Boss and the developer move work along; an OL asks and comments.
create or replace function public.dev_tasks_can_edit(uid uuid)
returns boolean language sql security definer set search_path = public stable as $fn$
  select public.is_boss(uid)
      or exists (select 1 from public.profiles p
                 where p.id = uid and p.is_active = true and p.role = 'developer');
$fn$;

alter table public.dev_tasks      enable row level security;
alter table public.dev_subtasks   enable row level security;
alter table public.dev_task_notes enable row level security;

drop policy if exists dev_tasks_select on public.dev_tasks;
create policy dev_tasks_select on public.dev_tasks for select
  using (public.dev_tasks_can_view(auth.uid()));

-- Anyone who can see may CREATE (an OL logging a request is the point).
drop policy if exists dev_tasks_insert on public.dev_tasks;
create policy dev_tasks_insert on public.dev_tasks for insert
  with check (public.dev_tasks_can_view(auth.uid()) and created_by = auth.uid());

-- ...but only Boss/developer may change one afterwards. The exception is the
-- requester acknowledging their own attribution, which an OL must be able to do.
drop policy if exists dev_tasks_update on public.dev_tasks;
create policy dev_tasks_update on public.dev_tasks for update
  using (public.dev_tasks_can_edit(auth.uid()) or requested_by = auth.uid())
  with check (public.dev_tasks_can_edit(auth.uid()) or requested_by = auth.uid());

drop policy if exists dev_tasks_delete on public.dev_tasks;
create policy dev_tasks_delete on public.dev_tasks for delete
  using (public.is_boss(auth.uid()));

drop policy if exists dev_subtasks_select on public.dev_subtasks;
create policy dev_subtasks_select on public.dev_subtasks for select
  using (public.dev_tasks_can_view(auth.uid()));
drop policy if exists dev_subtasks_write on public.dev_subtasks;
create policy dev_subtasks_write on public.dev_subtasks for all
  using (public.dev_tasks_can_edit(auth.uid()))
  with check (public.dev_tasks_can_edit(auth.uid()));

drop policy if exists dev_task_notes_select on public.dev_task_notes;
create policy dev_task_notes_select on public.dev_task_notes for select
  using (public.dev_tasks_can_view(auth.uid()));
-- Everyone who can see may comment — that is how "why is this blocked" gets
-- answered without leaving the app. Append-only: no update, no delete policy.
drop policy if exists dev_task_notes_insert on public.dev_task_notes;
create policy dev_task_notes_insert on public.dev_task_notes for insert
  with check (public.dev_tasks_can_view(auth.uid()) and author_id = auth.uid());

revoke all on public.dev_tasks, public.dev_subtasks, public.dev_task_notes from anon;
grant select, insert, update, delete on public.dev_tasks    to authenticated;
grant select, insert, update, delete on public.dev_subtasks to authenticated;
grant select, insert                 on public.dev_task_notes to authenticated;
grant select on public.dev_tasks_with_progress to authenticated;

-- ── Notifications: four, deliberately. More than this and people mute it. ──
create or replace function public.dev_task_notify()
returns trigger language plpgsql security definer set search_path = public as $fn$
declare
  v_actor uuid := auth.uid();
  v_actor_name text := coalesce(public.profile_display_name(v_actor), 'Someone');
  v_dev uuid;
begin
  select id into v_dev from public.profiles
   where role = 'developer' and is_active = true order by created_at limit 1;

  if tg_op = 'INSERT' then
    -- Someone else logged work for the developer.
    if v_dev is not null and v_dev <> v_actor then
      perform public.emit_notification(v_dev, v_actor, 'dev_task', 'dev_task.assigned',
        'New development task',
        v_actor_name || ' assigned you: ' || new.title,
        'dev_task', new.id, '/dev-tasks');
    end if;
    -- The developer named someone as the requester: tell them, so an
    -- attribution nobody made can be spotted rather than silently standing.
    if new.requested_by is not null and new.requested_by <> v_actor then
      perform public.emit_notification(new.requested_by, v_actor, 'dev_task', 'dev_task.attributed',
        'Logged as your request',
        v_actor_name || ' logged "' || new.title || '" as something you asked for. Open it to confirm.',
        'dev_task', new.id, '/dev-tasks');
    end if;
    return new;
  end if;

  if old.status is distinct from new.status then
    -- Blocked almost always means it is waiting on the requester.
    if new.status = 'blocked' and new.requested_by is not null and new.requested_by <> v_actor then
      perform public.emit_notification(new.requested_by, v_actor, 'dev_task', 'dev_task.blocked',
        'Development task blocked',
        v_actor_name || ' marked "' || new.title || '" as blocked.',
        'dev_task', new.id, '/dev-tasks');
    end if;
    if new.status = 'done' and new.requested_by is not null and new.requested_by <> v_actor then
      perform public.emit_notification(new.requested_by, v_actor, 'dev_task', 'dev_task.done',
        'Development task completed',
        '"' || new.title || '" is done.',
        'dev_task', new.id, '/dev-tasks');
    end if;
  end if;
  return new;
end;
$fn$;

drop trigger if exists dev_tasks_notify on public.dev_tasks;
create trigger dev_tasks_notify after insert or update on public.dev_tasks
  for each row execute function public.dev_task_notify();
