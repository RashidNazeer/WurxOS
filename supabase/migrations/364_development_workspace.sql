-- ============================================================
-- WurxOS v2 — Migration 364: the Development workspace.
--
-- Built from the owner's mockup "WurxOS - Development feature.html"
-- (2026-09-16). The tree is Project → Release → Task → Checklist:
--
--   dev_projects    products (WurxOS, Wurx Creator App, GMV Max Intel, …)
--   dev_releases    named deliveries with a target date; one is "current"
--   dev_tasks       the work, numbered WRX-101 onward
--   dev_checklist   small steps inside a task
--   dev_comments    the task thread: comments, one level of replies, @mentions
--   dev_files       files on a task or on a comment (private bucket dev-files)
--   dev_activity    every change, written ONLY by the triggers below
--
-- ── WHO CAN DO WHAT (owner's decisions, 2026-09-16) ─────────────────────
--   * Only the Boss and developers can see any of it.
--   * The Boss can change everything, including projects and releases.
--   * A developer can change only the tasks assigned to them: status, dates,
--     checklist, files, description. They cannot reassign a task away, and a
--     task they create is theirs. They can comment on every task.
--   * Only the Boss deletes a task.
-- RLS enforces all of it; the screens only mirror it.
--
-- ── NOTIFICATIONS ───────────────────────────────────────────────────────
-- Category `development`. The person who acted is never notified, a person
-- is notified once per event, and only the Boss and developers are ever
-- notified. Nothing is sent when there is no signed-in actor (a migration or
-- a maintenance script), so seeding pages nobody.
--   assigned          → the new owner
--   status change     → the Boss, the owner, the creator
--   bug reported      → the Boss and every developer
--   task created by a developer → the Boss
--   comment           → the Boss, the owner, the creator, earlier commenters
--   reply             → the comment's author and everyone in that thread
--   @mention          → the person mentioned
--   project added     → every developer
--   release shipped   → the Boss and every developer
--
-- Conventions kept: SECURITY DEFINER functions revoke EXECUTE from anon BY
-- NAME (mig 348: revoking from public is not enough); every UPDATE/DELETE has
-- a WHERE clause (pg_safeupdate, mig 319); identity comes from auth.uid(),
-- never current_user (mig 352).
-- ============================================================


-- ============================================================
-- 1. Access helpers
-- ============================================================
create function public.dev_is_member(uid uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
     where p.id = uid and p.is_active and p.deleted_at is null
       and p.role in ('boss', 'developer')
  );
$$;

create function public.dev_is_boss(uid uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
     where p.id = uid and p.is_active and p.deleted_at is null and p.role = 'boss'
  );
$$;

-- The Boss, or the developer the task is assigned to.
create function public.dev_can_edit_task(uid uuid, p_assignee uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
     where p.id = uid and p.is_active and p.deleted_at is null
       and (p.role = 'boss' or (p.role = 'developer' and p_assignee = uid))
  );
$$;

create function public.dev_boss_ids()
returns uuid[]
language sql stable security definer set search_path = public
as $$
  select coalesce(array_agg(id), '{}') from public.profiles
   where role = 'boss' and is_active and deleted_at is null;
$$;

create function public.dev_developer_ids()
returns uuid[]
language sql stable security definer set search_path = public
as $$
  select coalesce(array_agg(id), '{}') from public.profiles
   where role = 'developer' and is_active and deleted_at is null;
$$;


-- ============================================================
-- 2. Tables
-- ============================================================
create table public.dev_projects (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique
                check (length(key) between 2 and 30 and key ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name        text not null check (length(trim(name)) between 1 and 60),
  description text check (description is null or length(description) <= 300),
  color       text not null default 'orange'
                check (color in ('orange', 'violet', 'teal', 'blue', 'green', 'rose', 'amber', 'slate')),
  symbol      text not null check (length(symbol) between 1 and 2),
  stage       text not null default 'prelaunch' check (stage in ('live', 'prelaunch')),
  health      text not null default 'on_track' check (health in ('on_track', 'at_risk', 'off_track')),
  lead_id     uuid references public.profiles(id) on delete set null,
  member_ids  uuid[] not null default '{}',
  sort_order  integer not null default 0,
  archived_at timestamptz,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.dev_releases (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.dev_projects(id) on delete cascade,
  name        text not null check (length(trim(name)) between 1 and 80),
  description text check (description is null or length(description) <= 500),
  target_date date,
  status      text not null default 'planned' check (status in ('planned', 'current', 'shipped')),
  shipped_at  timestamptz,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index dev_releases_project_idx on public.dev_releases (project_id, status);
-- One current release per project; setting a new one demotes the old (trigger).
create unique index dev_releases_one_current on public.dev_releases (project_id) where status = 'current';

create sequence public.dev_task_number_seq start with 101;

create table public.dev_tasks (
  id                uuid primary key default gen_random_uuid(),
  number            bigint not null unique,
  project_id        uuid not null references public.dev_projects(id) on delete restrict,
  release_id        uuid references public.dev_releases(id) on delete set null,
  type              text not null default 'feature' check (type in ('feature', 'bug')),
  title             text not null check (length(trim(title)) between 1 and 160),
  description       text check (description is null or length(description) <= 20000),
  status            text not null default 'todo'
                      check (status in ('todo', 'in_progress', 'in_review', 'blocked', 'done')),
  priority          text not null default 'normal' check (priority in ('urgent', 'high', 'normal', 'low')),
  assignee_id       uuid references public.profiles(id) on delete set null,
  created_by        uuid references public.profiles(id) on delete set null,
  due_date          date,
  blocked_reason    text check (blocked_reason is null or length(blocked_reason) <= 1000),
  status_changed_at timestamptz not null default now(),
  completed_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint dev_tasks_blocked_needs_reason check (status <> 'blocked' or blocked_reason is not null)
);
create index dev_tasks_project_idx  on public.dev_tasks (project_id, release_id, status);
create index dev_tasks_assignee_idx on public.dev_tasks (assignee_id, status);

create table public.dev_checklist (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid not null references public.dev_tasks(id) on delete cascade,
  body       text not null check (length(trim(body)) between 1 and 200),
  done       boolean not null default false,
  done_by    uuid references public.profiles(id) on delete set null,
  done_at    timestamptz,
  sort_order double precision not null default 0,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index dev_checklist_task_idx on public.dev_checklist (task_id, sort_order);

create table public.dev_comments (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid not null references public.dev_tasks(id) on delete cascade,
  parent_id  uuid references public.dev_comments(id) on delete cascade,
  author_id  uuid references public.profiles(id) on delete set null,
  body       text not null default '',
  mentions   uuid[] not null default '{}',
  edited_at  timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  -- A deleted comment keeps its place in the thread with its text removed.
  constraint dev_comments_body_check
    check (deleted_at is not null or length(trim(body)) between 1 and 5000)
);
create index dev_comments_task_idx on public.dev_comments (task_id, created_at);

create table public.dev_files (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references public.dev_tasks(id) on delete cascade,
  comment_id  uuid references public.dev_comments(id) on delete cascade,
  path        text not null unique,
  name        text not null check (length(name) between 1 and 200),
  mime        text,
  size_bytes  bigint check (size_bytes is null or size_bytes between 0 and 26214400),
  uploaded_by uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index dev_files_task_idx on public.dev_files (task_id, created_at);

create table public.dev_activity (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid references public.dev_projects(id) on delete cascade,
  release_id uuid references public.dev_releases(id) on delete set null,
  task_id    uuid references public.dev_tasks(id) on delete cascade,
  actor_id   uuid references public.profiles(id) on delete set null,
  kind       text not null,
  payload    jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index dev_activity_recent_idx  on public.dev_activity (created_at desc);
create index dev_activity_task_idx    on public.dev_activity (task_id, created_at desc);
create index dev_activity_project_idx on public.dev_activity (project_id, created_at desc);

-- Counts for cards, read with the caller's own permissions.
create view public.dev_task_stats with (security_invoker = true) as
select t.id as task_id,
       (select count(*) from public.dev_comments c where c.task_id = t.id and c.deleted_at is null)::int as comments,
       (select count(*) from public.dev_files f where f.task_id = t.id)::int                          as files,
       (select count(*) from public.dev_checklist k where k.task_id = t.id)::int                      as checklist_total,
       (select count(*) from public.dev_checklist k where k.task_id = t.id and k.done)::int           as checklist_done
  from public.dev_tasks t;


-- ============================================================
-- 3. Notification + history helpers (internal: triggers only)
-- ============================================================
-- Sends one `development` notification to each distinct recipient, skipping
-- the actor, anyone in p_skip, and anyone who is not the Boss or a developer.
-- Returns who was notified, so a second message for the same event can skip
-- them. No signed-in actor → nothing is sent.
create function public.dev_notify(
  p_recipients  uuid[],
  p_skip        uuid[],
  p_action      text,
  p_title       text,
  p_body        text,
  p_entity_type text,
  p_entity_id   uuid,
  p_link        text
)
returns uuid[]
language plpgsql security definer set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_sent  uuid[] := '{}';
  v_id    uuid;
begin
  if v_actor is null then
    return v_sent;
  end if;
  for v_id in
    select distinct r from unnest(coalesce(p_recipients, '{}')) r where r is not null
  loop
    continue when v_id = v_actor or v_id = any (coalesce(p_skip, '{}'));
    continue when not public.dev_is_member(v_id);
    perform public.emit_notification(v_id, v_actor, 'development', p_action,
                                     p_title, p_body, p_entity_type, p_entity_id, p_link);
    v_sent := v_sent || v_id;
  end loop;
  return v_sent;
end;
$$;

create function public.dev_log(
  p_project uuid, p_release uuid, p_task uuid, p_kind text, p_payload jsonb
)
returns void
language sql security definer set search_path = public
as $$
  insert into public.dev_activity (project_id, release_id, task_id, actor_id, kind, payload)
  values (p_project, p_release, p_task, auth.uid(), p_kind, coalesce(p_payload, '{}'));
$$;

create function public.dev_status_label(p_status text)
returns text
language sql immutable set search_path = public
as $$
  select case p_status
    when 'todo' then 'To do'
    when 'in_progress' then 'In progress'
    when 'in_review' then 'In review'
    when 'blocked' then 'Blocked'
    when 'done' then 'Done'
    else p_status end;
$$;

-- ============================================================
-- 4. Projects
-- ============================================================
create function public.dev_projects_before()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  new.key := lower(trim(new.key));
  new.name := trim(new.name);
  new.symbol := upper(trim(new.symbol));
  new.description := nullif(trim(coalesce(new.description, '')), '');
  new.member_ids := coalesce(
    (select array_agg(distinct m) from unnest(new.member_ids) m where public.dev_is_member(m)), '{}');
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
  else
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger dev_projects_before
  before insert or update on public.dev_projects
  for each row execute function public.dev_projects_before();

create function public.dev_projects_after()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_actor text := coalesce(public.profile_display_name(auth.uid()), 'Someone');
begin
  if tg_op = 'INSERT' then
    perform public.dev_log(new.id, null, null, 'project_created', jsonb_build_object('name', new.name));
    perform public.dev_notify(public.dev_developer_ids(), '{}', 'development.project',
      'New project: ' || new.name,
      v_actor || ' added ' || new.name || ' to Development.',
      'dev_project', new.id, '/development/projects/' || new.key);
  elsif new.archived_at is distinct from old.archived_at then
    perform public.dev_log(new.id, null, null,
      case when new.archived_at is null then 'project_restored' else 'project_archived' end,
      jsonb_build_object('name', new.name));
  elsif (new.name, new.description, new.color, new.symbol, new.stage, new.health, new.lead_id, new.member_ids)
        is distinct from
        (old.name, old.description, old.color, old.symbol, old.stage, old.health, old.lead_id, old.member_ids) then
    perform public.dev_log(new.id, null, null, 'project_updated',
      jsonb_build_object('name', new.name,
                         'health', case when new.health is distinct from old.health
                                        then jsonb_build_object('from', old.health, 'to', new.health) end));
  end if;
  return null;
end;
$$;

create trigger dev_projects_after
  after insert or update on public.dev_projects
  for each row execute function public.dev_projects_after();


-- ============================================================
-- 5. Releases
-- ============================================================
create function public.dev_releases_before()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  new.name := trim(new.name);
  new.description := nullif(trim(coalesce(new.description, '')), '');
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
  else
    new.project_id := old.project_id;       -- a release never changes project
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;

  if new.status = 'shipped' then
    new.shipped_at := coalesce(case when tg_op = 'UPDATE' and old.status = 'shipped' then old.shipped_at end, now());
  else
    new.shipped_at := null;
  end if;

  -- Making this release current demotes the project's previous current one.
  if new.status = 'current' then
    update public.dev_releases
       set status = 'planned'
     where project_id = new.project_id
       and status = 'current'
       and id <> new.id;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger dev_releases_before
  before insert or update on public.dev_releases
  for each row execute function public.dev_releases_before();

create function public.dev_releases_after()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_actor   text := coalesce(public.profile_display_name(auth.uid()), 'Someone');
  v_project public.dev_projects%rowtype;
begin
  select * into v_project from public.dev_projects where id = new.project_id;
  if tg_op = 'INSERT' then
    perform public.dev_log(new.project_id, new.id, null, 'release_created',
      jsonb_build_object('name', new.name, 'status', new.status, 'target_date', new.target_date));
    return null;
  end if;

  if new.status is distinct from old.status then
    perform public.dev_log(new.project_id, new.id, null, 'release_status',
      jsonb_build_object('name', new.name, 'from', old.status, 'to', new.status));
    if new.status = 'shipped' then
      perform public.dev_notify(public.dev_boss_ids() || public.dev_developer_ids(), '{}',
        'development.release_shipped',
        'Shipped: ' || new.name,
        v_actor || ' shipped ' || new.name || ' for ' || coalesce(v_project.name, 'a project') || '.',
        'dev_project', new.project_id, '/development/projects/' || v_project.key);
    end if;
  elsif (new.name, new.description, new.target_date) is distinct from (old.name, old.description, old.target_date) then
    perform public.dev_log(new.project_id, new.id, null, 'release_updated',
      jsonb_build_object('name', new.name,
                         'target_date', case when new.target_date is distinct from old.target_date
                                             then jsonb_build_object('from', old.target_date, 'to', new.target_date) end));
  end if;
  return null;
end;
$$;

create trigger dev_releases_after
  after insert or update on public.dev_releases
  for each row execute function public.dev_releases_after();


-- ============================================================
-- 6. Tasks
-- ============================================================
create function public.dev_tasks_before()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_release_project uuid;
begin
  if tg_op = 'INSERT' then
    new.number := nextval('public.dev_task_number_seq');
    new.created_by := auth.uid();
    new.created_at := now();
    new.status_changed_at := now();
  else
    new.number := old.number;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    if new.status is distinct from old.status then
      new.status_changed_at := now();
    else
      new.status_changed_at := old.status_changed_at;
    end if;
  end if;

  new.title := trim(new.title);

  if new.status = 'done' then
    new.completed_at := coalesce(case when tg_op = 'UPDATE' and old.status = 'done' then old.completed_at end, now());
  else
    new.completed_at := null;
  end if;

  if new.status = 'blocked' then
    new.blocked_reason := nullif(trim(coalesce(new.blocked_reason, '')), '');
    if new.blocked_reason is null then
      raise exception 'Say what is blocking this task.' using errcode = '23514';
    end if;
  else
    new.blocked_reason := null;
  end if;

  if new.release_id is not null then
    select project_id into v_release_project from public.dev_releases where id = new.release_id;
    if v_release_project is distinct from new.project_id then
      raise exception 'That release belongs to a different project.' using errcode = '22023';
    end if;
  end if;

  if new.assignee_id is not null
     and (tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id)
     and not public.dev_is_member(new.assignee_id) then
    raise exception 'A task can only be assigned to the Boss or a developer.' using errcode = '22023';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger dev_tasks_before
  before insert or update on public.dev_tasks
  for each row execute function public.dev_tasks_before();

create function public.dev_tasks_after()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_actor   text := coalesce(public.profile_display_name(v_uid), 'Someone');
  v_code    text := 'WRX-' || new.number;
  v_link    text := '/development/roadmap?task=' || new.number;
  v_sent    uuid[] := '{}';
  v_action  text;
  v_title   text;
  v_body    text;
begin
  if tg_op = 'INSERT' then
    perform public.dev_log(new.project_id, new.release_id, new.id, 'task_created',
      jsonb_build_object('title', new.title, 'type', new.type, 'status', new.status,
                         'priority', new.priority, 'assignee_id', new.assignee_id));

    if new.assignee_id is not null then
      v_sent := public.dev_notify(array[new.assignee_id], '{}', 'development.assigned',
        'Assigned to you: ' || v_code,
        v_actor || ' assigned you "' || new.title || '".',
        'dev_task', new.id, v_link);
    end if;

    if new.type = 'bug' then
      perform public.dev_notify(public.dev_boss_ids() || public.dev_developer_ids(), v_sent,
        'development.bug_reported',
        'Bug reported: ' || v_code,
        v_actor || ' reported "' || new.title || '".',
        'dev_task', new.id, v_link);
    elsif not public.dev_is_boss(v_uid) then
      perform public.dev_notify(public.dev_boss_ids(), v_sent, 'development.task_created',
        'New task: ' || v_code,
        v_actor || ' added "' || new.title || '".',
        'dev_task', new.id, v_link);
    end if;
    return null;
  end if;

  -- ── history: one entry per changed field ──
  if new.status is distinct from old.status then
    perform public.dev_log(new.project_id, new.release_id, new.id, 'status',
      jsonb_build_object('from', old.status, 'to', new.status, 'reason', new.blocked_reason));
  end if;
  if new.assignee_id is distinct from old.assignee_id then
    perform public.dev_log(new.project_id, new.release_id, new.id, 'assignee',
      jsonb_build_object('from', old.assignee_id, 'to', new.assignee_id));
  end if;
  if new.priority is distinct from old.priority then
    perform public.dev_log(new.project_id, new.release_id, new.id, 'priority',
      jsonb_build_object('from', old.priority, 'to', new.priority));
  end if;
  if new.due_date is distinct from old.due_date then
    perform public.dev_log(new.project_id, new.release_id, new.id, 'due_date',
      jsonb_build_object('from', old.due_date, 'to', new.due_date));
  end if;
  if new.release_id is distinct from old.release_id or new.project_id is distinct from old.project_id then
    perform public.dev_log(new.project_id, new.release_id, new.id, 'moved',
      jsonb_build_object('from_project', old.project_id, 'to_project', new.project_id,
                         'from_release', old.release_id, 'to_release', new.release_id));
  end if;
  if new.title is distinct from old.title then
    perform public.dev_log(new.project_id, new.release_id, new.id, 'title',
      jsonb_build_object('from', old.title, 'to', new.title));
  end if;
  if new.type is distinct from old.type then
    perform public.dev_log(new.project_id, new.release_id, new.id, 'type',
      jsonb_build_object('from', old.type, 'to', new.type));
  end if;
  if new.description is distinct from old.description then
    perform public.dev_log(new.project_id, new.release_id, new.id, 'description', '{}');
  end if;
  if new.status = 'blocked' and old.status = 'blocked' and new.blocked_reason is distinct from old.blocked_reason then
    perform public.dev_log(new.project_id, new.release_id, new.id, 'blocked_reason',
      jsonb_build_object('reason', new.blocked_reason));
  end if;

  -- ── notifications ──
  if new.assignee_id is distinct from old.assignee_id and new.assignee_id is not null then
    v_sent := public.dev_notify(array[new.assignee_id], '{}', 'development.assigned',
      'Assigned to you: ' || v_code,
      v_actor || ' assigned you "' || new.title || '".',
      'dev_task', new.id, v_link);
  end if;

  if new.status is distinct from old.status then
    if new.status = 'blocked' then
      v_action := 'development.blocked';
      v_title  := 'Blocked: ' || v_code;
      v_body   := v_actor || ' blocked "' || new.title || '": ' || new.blocked_reason;
    elsif new.status = 'done' then
      v_action := 'development.done';
      v_title  := 'Done: ' || v_code;
      v_body   := v_actor || ' finished "' || new.title || '".';
    elsif new.status = 'in_review' then
      v_action := 'development.review';
      v_title  := 'Ready for review: ' || v_code;
      v_body   := v_actor || ' sent "' || new.title || '" for review.';
    else
      v_action := 'development.status';
      v_title  := v_code || ' is ' || public.dev_status_label(new.status);
      v_body   := v_actor || ' moved "' || new.title || '" to ' || public.dev_status_label(new.status) || '.';
    end if;
    perform public.dev_notify(public.dev_boss_ids() || array[new.assignee_id, new.created_by], v_sent,
      v_action, v_title, v_body, 'dev_task', new.id, v_link);
  end if;

  return null;
end;
$$;

create trigger dev_tasks_after
  after insert or update on public.dev_tasks
  for each row execute function public.dev_tasks_after();

create function public.dev_tasks_after_delete()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  perform public.dev_log(old.project_id, old.release_id, null, 'task_deleted',
    jsonb_build_object('number', old.number, 'title', old.title));
  return null;
end;
$$;

create trigger dev_tasks_after_delete
  after delete on public.dev_tasks
  for each row execute function public.dev_tasks_after_delete();


-- ============================================================
-- 7. Checklist
-- ============================================================
create function public.dev_checklist_before()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  new.body := trim(new.body);
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
  else
    new.task_id := old.task_id;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  if new.done and (tg_op = 'INSERT' or not old.done) then
    new.done_by := auth.uid();
    new.done_at := now();
  elsif not new.done then
    new.done_by := null;
    new.done_at := null;
  else
    new.done_by := old.done_by;
    new.done_at := old.done_at;
  end if;
  return new;
end;
$$;

create trigger dev_checklist_before
  before insert or update on public.dev_checklist
  for each row execute function public.dev_checklist_before();

create function public.dev_checklist_after()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_task public.dev_tasks%rowtype;
  v_row  public.dev_checklist%rowtype := case when tg_op = 'DELETE' then old else new end;
begin
  select * into v_task from public.dev_tasks where id = v_row.task_id;
  if not found then return null; end if;   -- the task itself is being deleted

  if tg_op = 'INSERT' then
    perform public.dev_log(v_task.project_id, v_task.release_id, v_task.id, 'checklist_added',
      jsonb_build_object('body', new.body));
  elsif tg_op = 'DELETE' then
    perform public.dev_log(v_task.project_id, v_task.release_id, v_task.id, 'checklist_removed',
      jsonb_build_object('body', old.body));
  elsif new.done is distinct from old.done then
    perform public.dev_log(v_task.project_id, v_task.release_id, v_task.id,
      case when new.done then 'checklist_done' else 'checklist_reopened' end,
      jsonb_build_object('body', new.body));
  elsif new.body is distinct from old.body then
    perform public.dev_log(v_task.project_id, v_task.release_id, v_task.id, 'checklist_edited',
      jsonb_build_object('from', old.body, 'to', new.body));
  end if;
  return null;
end;
$$;

create trigger dev_checklist_after
  after insert or update or delete on public.dev_checklist
  for each row execute function public.dev_checklist_after();


-- ============================================================
-- 8. Comments
-- ============================================================
create function public.dev_comments_before()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_parent public.dev_comments%rowtype;
begin
  if tg_op = 'INSERT' then
    new.author_id := v_uid;
    new.created_at := now();
    new.edited_at := null;
    new.deleted_at := null;
    new.body := trim(new.body);
    if new.parent_id is not null then
      select * into v_parent from public.dev_comments where id = new.parent_id;
      if not found or v_parent.task_id <> new.task_id then
        raise exception 'That comment is not on this task.' using errcode = '22023';
      end if;
      -- Replies stay one level deep: a reply to a reply joins the same thread.
      if v_parent.parent_id is not null then
        new.parent_id := v_parent.parent_id;
      end if;
    end if;
  else
    new.task_id := old.task_id;
    new.parent_id := old.parent_id;
    new.author_id := old.author_id;
    new.created_at := old.created_at;

    if old.deleted_at is not null then
      raise exception 'This comment was deleted.' using errcode = '22023';
    end if;

    if new.deleted_at is not null then
      new.deleted_at := now();
      new.body := '';
      new.mentions := '{}';
      new.edited_at := old.edited_at;
    else
      new.body := trim(new.body);
      if new.body is distinct from old.body then
        if v_uid is distinct from old.author_id then
          raise exception 'You can only edit your own comments.' using errcode = '42501';
        end if;
        new.edited_at := now();
      else
        new.edited_at := old.edited_at;
      end if;
    end if;
  end if;

  new.mentions := coalesce(
    (select array_agg(distinct m) from unnest(new.mentions) m
      where public.dev_is_member(m) and m is distinct from new.author_id), '{}');
  return new;
end;
$$;

create trigger dev_comments_before
  before insert or update on public.dev_comments
  for each row execute function public.dev_comments_before();

create function public.dev_comments_after()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_actor      text := coalesce(public.profile_display_name(auth.uid()), 'Someone');
  v_task       public.dev_tasks%rowtype;
  v_code       text;
  v_link       text;
  v_excerpt    text;
  v_sent       uuid[] := '{}';
  v_new_mentions uuid[];
  v_participants uuid[];
begin
  select * into v_task from public.dev_tasks where id = new.task_id;
  if not found then return null; end if;
  v_code := 'WRX-' || v_task.number;
  v_link := '/development/roadmap?task=' || v_task.number || '&comment=' || new.id;
  v_excerpt := left(regexp_replace(new.body, '\s+', ' ', 'g'), 180);

  if tg_op = 'UPDATE' then
    if new.deleted_at is not null and old.deleted_at is null then
      perform public.dev_log(v_task.project_id, v_task.release_id, v_task.id, 'comment_deleted',
        jsonb_build_object('comment_id', new.id));
      return null;
    end if;
    -- Only people newly @mentioned by an edit hear about it.
    select coalesce(array_agg(m), '{}') into v_new_mentions
      from unnest(new.mentions) m where not (m = any (old.mentions));
    perform public.dev_notify(v_new_mentions, '{}', 'development.mentioned',
      v_actor || ' mentioned you on ' || v_code, v_excerpt, 'dev_task', v_task.id, v_link);
    return null;
  end if;

  perform public.dev_log(v_task.project_id, v_task.release_id, v_task.id, 'comment',
    jsonb_build_object('comment_id', new.id, 'reply', new.parent_id is not null, 'excerpt', left(v_excerpt, 140)));

  v_sent := public.dev_notify(new.mentions, '{}', 'development.mentioned',
    v_actor || ' mentioned you on ' || v_code, v_excerpt, 'dev_task', v_task.id, v_link);

  if new.parent_id is null then
    select coalesce(array_agg(distinct author_id), '{}') into v_participants
      from public.dev_comments
     where task_id = v_task.id and id <> new.id and deleted_at is null and author_id is not null;
    perform public.dev_notify(
      public.dev_boss_ids() || array[v_task.assignee_id, v_task.created_by] || v_participants, v_sent,
      'development.comment', 'New comment on ' || v_code,
      v_actor || ': ' || v_excerpt, 'dev_task', v_task.id, v_link);
  else
    select coalesce(array_agg(distinct author_id), '{}') into v_participants
      from public.dev_comments
     where (id = new.parent_id or parent_id = new.parent_id)
       and id <> new.id and author_id is not null;
    perform public.dev_notify(v_participants, v_sent,
      'development.reply', v_actor || ' replied on ' || v_code,
      v_excerpt, 'dev_task', v_task.id, v_link);
  end if;
  return null;
end;
$$;

create trigger dev_comments_after
  after insert or update on public.dev_comments
  for each row execute function public.dev_comments_after();


-- ============================================================
-- 9. Files
-- ============================================================
create function public.dev_files_before()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_comment_task uuid;
begin
  new.uploaded_by := auth.uid();
  new.created_at := now();
  new.name := trim(new.name);
  -- Objects live at <task id>/<file id>-<name>, so a path always names its task.
  if split_part(new.path, '/', 1) <> new.task_id::text then
    raise exception 'The file path does not belong to this task.' using errcode = '22023';
  end if;
  if new.comment_id is not null then
    select task_id into v_comment_task from public.dev_comments where id = new.comment_id;
    if v_comment_task is distinct from new.task_id then
      raise exception 'That comment is not on this task.' using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;

create trigger dev_files_before
  before insert on public.dev_files
  for each row execute function public.dev_files_before();

create function public.dev_files_after()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_task public.dev_tasks%rowtype;
  v_row  public.dev_files%rowtype := case when tg_op = 'DELETE' then old else new end;
begin
  select * into v_task from public.dev_tasks where id = v_row.task_id;
  if not found then return null; end if;
  perform public.dev_log(v_task.project_id, v_task.release_id, v_task.id,
    case when tg_op = 'DELETE' then 'file_removed' else 'file_added' end,
    jsonb_build_object('name', v_row.name, 'on_comment', v_row.comment_id is not null));
  return null;
end;
$$;

create trigger dev_files_after
  after insert or delete on public.dev_files
  for each row execute function public.dev_files_after();


-- ============================================================
-- 10. Row level security
-- ============================================================
alter table public.dev_projects  enable row level security;
alter table public.dev_releases  enable row level security;
alter table public.dev_tasks     enable row level security;
alter table public.dev_checklist enable row level security;
alter table public.dev_comments  enable row level security;
alter table public.dev_files     enable row level security;
alter table public.dev_activity  enable row level security;

-- Projects and releases: everyone in Development reads, the Boss writes.
create policy dev_projects_read  on public.dev_projects for select using (public.dev_is_member(auth.uid()));
create policy dev_projects_write on public.dev_projects for all
  using (public.dev_is_boss(auth.uid())) with check (public.dev_is_boss(auth.uid()));

create policy dev_releases_read  on public.dev_releases for select using (public.dev_is_member(auth.uid()));
create policy dev_releases_write on public.dev_releases for all
  using (public.dev_is_boss(auth.uid())) with check (public.dev_is_boss(auth.uid()));

-- Tasks. A developer creates tasks for themselves, changes only tasks assigned
-- to them, and cannot hand one to someone else. Only the Boss deletes.
create policy dev_tasks_read on public.dev_tasks for select using (public.dev_is_member(auth.uid()));
create policy dev_tasks_create on public.dev_tasks for insert
  with check (public.dev_is_member(auth.uid())
              and (public.dev_is_boss(auth.uid()) or assignee_id = auth.uid()));
create policy dev_tasks_change on public.dev_tasks for update
  using (public.dev_can_edit_task(auth.uid(), assignee_id))
  with check (public.dev_is_boss(auth.uid()) or assignee_id = auth.uid());
create policy dev_tasks_delete on public.dev_tasks for delete using (public.dev_is_boss(auth.uid()));

-- Checklist follows its task.
create policy dev_checklist_read on public.dev_checklist for select using (public.dev_is_member(auth.uid()));
create policy dev_checklist_write on public.dev_checklist for all
  using (exists (select 1 from public.dev_tasks t
                  where t.id = dev_checklist.task_id
                    and public.dev_can_edit_task(auth.uid(), t.assignee_id)))
  with check (exists (select 1 from public.dev_tasks t
                       where t.id = dev_checklist.task_id
                         and public.dev_can_edit_task(auth.uid(), t.assignee_id)));

-- Comments: everyone in Development comments on every task. Authors edit and
-- delete their own; the Boss can delete any (the trigger stops the Boss
-- rewriting someone else's words). No hard delete from the app.
create policy dev_comments_read   on public.dev_comments for select using (public.dev_is_member(auth.uid()));
create policy dev_comments_create on public.dev_comments for insert with check (public.dev_is_member(auth.uid()));
create policy dev_comments_change on public.dev_comments for update
  using (public.dev_is_member(auth.uid()) and (author_id = auth.uid() or public.dev_is_boss(auth.uid())))
  with check (public.dev_is_member(auth.uid()));

-- Files: on a comment, anyone in Development; on the task itself, whoever can
-- change the task. Removed by the uploader or the Boss.
create policy dev_files_read on public.dev_files for select using (public.dev_is_member(auth.uid()));
create policy dev_files_create on public.dev_files for insert
  with check (public.dev_is_member(auth.uid())
              and (comment_id is not null
                   or exists (select 1 from public.dev_tasks t
                               where t.id = dev_files.task_id
                                 and public.dev_can_edit_task(auth.uid(), t.assignee_id))));
create policy dev_files_delete on public.dev_files for delete
  using (uploaded_by = auth.uid() or public.dev_is_boss(auth.uid()));

-- History is read-only for everyone; only the triggers write it.
create policy dev_activity_read on public.dev_activity for select using (public.dev_is_member(auth.uid()));

revoke all on public.dev_projects, public.dev_releases, public.dev_tasks, public.dev_checklist,
              public.dev_comments, public.dev_files, public.dev_activity, public.dev_task_stats
  from anon;
grant select, insert, update, delete on public.dev_projects, public.dev_releases, public.dev_tasks,
                                         public.dev_checklist, public.dev_files to authenticated;
grant select, insert, update on public.dev_comments to authenticated;
grant select on public.dev_activity, public.dev_task_stats to authenticated;
revoke all on sequence public.dev_task_number_seq from anon, authenticated;


-- ============================================================
-- 11. Storage: private bucket for task and comment files
-- ============================================================
insert into storage.buckets (id, name, public, file_size_limit)
values ('dev-files', 'dev-files', false, 26214400)
on conflict (id) do nothing;

create policy dev_files_objects_read on storage.objects for select to authenticated
  using (bucket_id = 'dev-files' and public.dev_is_member(auth.uid()));
create policy dev_files_objects_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'dev-files' and public.dev_is_member(auth.uid()));
create policy dev_files_objects_remove on storage.objects for delete to authenticated
  using (bucket_id = 'dev-files'
         and (owner_id = auth.uid()::text or public.dev_is_boss(auth.uid())));


-- ============================================================
-- 12. Live updates
-- ============================================================
do $rt$
declare t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    return;
  end if;
  foreach t in array array['dev_projects', 'dev_releases', 'dev_tasks', 'dev_checklist',
                           'dev_comments', 'dev_files', 'dev_activity'] loop
    if not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end;
$rt$;


-- ============================================================
-- 13. Function permissions (anon BY NAME — see mig 348)
-- ============================================================
do $g$
declare f text;
begin
  -- Used inside RLS policies, so signed-in users must be able to run them.
  foreach f in array array['public.dev_is_member(uuid)', 'public.dev_is_boss(uuid)',
                           'public.dev_can_edit_task(uuid, uuid)'] loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('grant execute on function %s to authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;

  -- Internal: only the triggers call these.
  foreach f in array array['public.dev_boss_ids()', 'public.dev_developer_ids()',
                           'public.dev_notify(uuid[], uuid[], text, text, text, text, uuid, text)',
                           'public.dev_log(uuid, uuid, uuid, text, jsonb)',
                           'public.dev_status_label(text)',
                           'public.dev_projects_before()', 'public.dev_projects_after()',
                           'public.dev_releases_before()', 'public.dev_releases_after()',
                           'public.dev_tasks_before()', 'public.dev_tasks_after()',
                           'public.dev_tasks_after_delete()',
                           'public.dev_checklist_before()', 'public.dev_checklist_after()',
                           'public.dev_comments_before()', 'public.dev_comments_after()',
                           'public.dev_files_before()', 'public.dev_files_after()'] loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('revoke all on function %s from authenticated', f);
  end loop;
end;
$g$;


-- ============================================================
-- 14. Starting projects (no releases or tasks — those are the Boss's to add)
-- ============================================================
insert into public.dev_projects (key, name, description, color, symbol, stage, sort_order)
values
  ('wurxos',        'WurxOS',           'The operating system for our team.',          'orange', 'W', 'live',      0),
  ('creator-app',   'Wurx Creator App', 'Better partnerships. One creator workspace.', 'violet', 'C', 'prelaunch', 1),
  ('gmv-max-intel', 'GMV Max Intel',    'Turn campaign data into better decisions.',   'teal',   'G', 'prelaunch', 2);


-- ============================================================
-- VERIFY
-- ============================================================
do $v$
declare
  v text;
begin
  select string_agg(t, ', ') into v
    from unnest(array['dev_projects', 'dev_releases', 'dev_tasks', 'dev_checklist',
                      'dev_comments', 'dev_files', 'dev_activity']) t
   where not exists (select 1 from pg_class c where c.relnamespace = 'public'::regnamespace
                                                and c.relname = t and c.relrowsecurity);
  if v is not null then raise exception '364: missing or without RLS: %', v; end if;

  select string_agg(p.proname, ', ') into v
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname like 'dev\_%'
     and has_function_privilege('anon', p.oid, 'EXECUTE');
  if v is not null then raise exception '364: logged-out users can run: %', v; end if;

  if not exists (select 1 from storage.buckets where id = 'dev-files' and not public) then
    raise exception '364: private bucket dev-files missing';
  end if;

  if (select count(*) from public.dev_projects) < 3 then
    raise exception '364: starting projects missing';
  end if;

  if exists (select 1 from public.notifications where category = 'development') then
    raise exception '364: seeding sent notifications';
  end if;

  raise notice '364: Development workspace ready';
end;
$v$;
