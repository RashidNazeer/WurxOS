-- ============================================================
-- WurxOS v2 — Migration 361: Development workspace v2.
--
-- Keeps existing data introduced by 328/329, while promoting the old levels:
--   dev_projects -> products, dev_tasks -> features, dev_subtasks -> tasks.
-- Status changes and planning moves are RPC-only so review authority cannot
-- be bypassed by editing a request in the browser console.
-- ============================================================

-- Products ----------------------------------------------------
alter table public.dev_projects
  add column if not exists stage text not null default 'prelaunch',
  add column if not exists system_key text;

alter table public.dev_projects drop constraint if exists dev_projects_stage_check;
alter table public.dev_projects add constraint dev_projects_stage_check
  check (stage in ('live', 'prelaunch'));
create unique index if not exists dev_projects_system_key_uidx
  on public.dev_projects (system_key) where system_key is not null;

insert into public.dev_projects (name, description, colour, stage, system_key)
values
  ('WurxOS', 'Internal operations platform', 'blue', 'live', 'wurxos'),
  ('Wurx Creator App', 'Creator-facing application', 'violet', 'prelaunch', 'creator-app'),
  ('GMV Max Intel', 'Advertising intelligence product', 'amber', 'prelaunch', 'gmv-max-intel')
on conflict (name) do update set
  stage = excluded.stage,
  system_key = coalesce(public.dev_projects.system_key, excluded.system_key);

-- The first product used by the old page was WurxOS. Keep uncategorised
-- history visible instead of leaving it outside the new roadmap.
update public.dev_tasks t
   set project_id = p.id
  from public.dev_projects p
 where t.project_id is null and p.system_key = 'wurxos';

-- Two-week planning blocks ------------------------------------
create table if not exists public.dev_blocks (
  id         uuid primary key default gen_random_uuid(),
  starts_on  date not null unique,
  ends_on    date generated always as (starts_on + 13) stored,
  created_at timestamptz not null default now()
);

create or replace function public.dev_ensure_blocks(p_from date default null)
returns setof public.dev_blocks
language plpgsql security definer set search_path = public as $fn$
declare
  -- The approved planning calendar starts 15–28 Sept 2026. Keep that exact
  -- cadence; the source artifact labels the 15th as Monday, although the
  -- Gregorian weekday is Tuesday.
  v_anchor date := date '2026-09-15';
  v_day date := coalesce(p_from, (now() at time zone 'Asia/Karachi')::date);
  v_start date;
  i int;
begin
  if not public.dev_tasks_can_view(auth.uid()) then
    raise exception 'not allowed';
  end if;
  v_start := v_anchor + (floor((v_day - v_anchor) / 14.0)::int * 14);
  for i in 0..3 loop
    insert into public.dev_blocks (starts_on) values (v_start + (i * 14))
    on conflict (starts_on) do nothing;
  end loop;
  return query
    select b.* from public.dev_blocks b
     where b.starts_on between v_start and v_start + 42
     order by b.starts_on;
end;
$fn$;

-- Developer seniority is explicit. The oldest existing developer is seeded
-- senior so a one-developer installation continues to work; the Boss can
-- change this row when the junior account is added.
create table if not exists public.dev_team_members (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  level      text not null default 'junior' check (level in ('senior', 'junior')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.dev_team_members (user_id, level)
select p.id,
       case when row_number() over (order by p.created_at, p.id) = 1
            then 'senior' else 'junior' end
  from public.profiles p
 where p.role = 'developer' and p.is_active and p.deleted_at is null
on conflict (user_id) do nothing;

drop trigger if exists dev_team_members_touch on public.dev_team_members;
create trigger dev_team_members_touch before update on public.dev_team_members
  for each row execute function public.dev_touch_updated_at();

create or replace function public.dev_sync_team_member()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  if new.role = 'developer' and new.is_active and new.deleted_at is null then
    insert into public.dev_team_members(user_id, level)
    values (new.id, case when exists (select 1 from public.dev_team_members where level = 'senior')
                         then 'junior' else 'senior' end)
    on conflict (user_id) do nothing;
  end if;
  return new;
end;
$fn$;

drop trigger if exists profiles_sync_dev_team on public.profiles;
create trigger profiles_sync_dev_team after insert or update of role, is_active, deleted_at on public.profiles
  for each row execute function public.dev_sync_team_member();

-- Features ----------------------------------------------------
alter table public.dev_tasks
  add column if not exists block_id uuid references public.dev_blocks(id) on delete set null,
  add column if not exists owner_id uuid references public.profiles(id) on delete set null,
  add column if not exists planned_task_count int,
  add column if not exists is_standing boolean not null default false;

update public.dev_tasks set owner_id = assigned_to
 where owner_id is null and assigned_to is not null;
update public.dev_tasks t set owner_id = d.user_id
  from (select user_id from public.dev_team_members order by level = 'senior' desc, created_at limit 1) d
 where t.owner_id is null;

alter table public.dev_tasks drop constraint if exists dev_tasks_priority_check;
update public.dev_tasks set priority = case
  when priority = 'urgent' then 'urgent'
  when priority = 'high' then 'high'
  else 'normal' end;
alter table public.dev_tasks alter column priority set default 'normal';
alter table public.dev_tasks add constraint dev_tasks_priority_check
  check (priority in ('normal', 'high', 'urgent'));
alter table public.dev_tasks drop constraint if exists dev_feature_name_length_check;
alter table public.dev_tasks add constraint dev_feature_name_length_check
  check (length(trim(title)) <= 40) not valid;

create or replace function public.dev_guard_feature_update()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  if old.block_id is distinct from new.block_id and
     coalesce(current_setting('app.dev_planning', true), '') <> 'allowed' then
    raise exception 'use the roadmap planning action';
  end if;
  return new;
end;
$fn$;

drop trigger if exists dev_tasks_guard_planning on public.dev_tasks;
create trigger dev_tasks_guard_planning before update on public.dev_tasks
  for each row execute function public.dev_guard_feature_update();

create or replace function public.dev_keep_standing_feature()
returns trigger language plpgsql as $fn$
begin
  if old.is_standing then raise exception 'standing feature cannot be deleted'; end if;
  return old;
end;
$fn$;
drop trigger if exists dev_tasks_keep_standing on public.dev_tasks;
create trigger dev_tasks_keep_standing before delete on public.dev_tasks
  for each row execute function public.dev_keep_standing_feature();

-- Reviewable tasks --------------------------------------------
alter table public.dev_subtasks
  add column if not exists acceptance_check text,
  add column if not exists owner_id uuid references public.profiles(id) on delete set null,
  add column if not exists reviewer_id uuid references public.profiles(id) on delete set null,
  add column if not exists final_reviewer_id uuid references public.profiles(id) on delete set null,
  add column if not exists blocked_reason text,
  add column if not exists source text not null default 'manual',
  add column if not exists reporter_id uuid references public.profiles(id) on delete set null,
  add column if not exists page_url text,
  add column if not exists expected text,
  add column if not exists screenshot_path text,
  add column if not exists duplicate_of uuid references public.dev_subtasks(id) on delete set null,
  add column if not exists resolution text,
  add column if not exists status_changed_at timestamptz not null default now();

alter table public.dev_subtasks drop constraint if exists dev_subtasks_priority_check;
update public.dev_subtasks set priority = case
  when priority = 'urgent' then 'urgent'
  when priority = 'high' then 'high'
  else 'normal' end;
alter table public.dev_subtasks alter column priority set default 'normal';
alter table public.dev_subtasks add constraint dev_subtasks_priority_check
  check (priority in ('normal', 'high', 'urgent'));

alter table public.dev_subtasks drop constraint if exists dev_subtasks_status_check;
update public.dev_subtasks set status = case
  when status = 'done' then 'live'
  when status = 'blocked' then 'blocked'
  when status = 'in_progress' then 'in_progress'
  when status = 'paused' then 'backlog'
  when status = 'cancelled' then 'backlog'
  else 'planned' end;
alter table public.dev_subtasks alter column status set default 'backlog';
alter table public.dev_subtasks add constraint dev_subtasks_status_check
  check (status in ('backlog','planned','in_progress','blocked','dev_review','your_review','tested','live'));
alter table public.dev_subtasks drop constraint if exists dev_subtasks_source_check;
alter table public.dev_subtasks add constraint dev_subtasks_source_check
  check (source in ('manual', 'bug_report'));
alter table public.dev_subtasks drop constraint if exists dev_subtasks_resolution_check;
alter table public.dev_subtasks add constraint dev_subtasks_resolution_check
  check (resolution is null or resolution = 'duplicate');

update public.dev_subtasks s
   set owner_id = coalesce(s.owner_id, t.owner_id),
       acceptance_check = coalesce(nullif(trim(s.acceptance_check), ''), s.description)
  from public.dev_tasks t where t.id = s.task_id;

-- Reviewer defaults. These are also applied to new rows by the trigger below.
create or replace function public.dev_fill_reviewers()
returns trigger language plpgsql security definer set search_path = public as $fn$
declare
  v_level text;
begin
  if tg_op = 'INSERT' then
    if new.status not in ('backlog', 'planned') then
      raise exception 'new tasks start in Backlog or Planned';
    end if;
    if new.status = 'planned' and coalesce(trim(new.acceptance_check), '') = '' then
      raise exception 'Add an acceptance check before scheduling';
    end if;
  end if;
  if tg_op = 'UPDATE' and old.owner_id is distinct from new.owner_id then
    new.reviewer_id := null;
  end if;
  if new.owner_id is null then
    select owner_id into new.owner_id from public.dev_tasks where id = new.task_id;
  end if;
  select level into v_level from public.dev_team_members where user_id = new.owner_id;
  if new.final_reviewer_id is null then
    select id into new.final_reviewer_id from public.profiles
     where role = 'boss' and is_active and deleted_at is null order by created_at limit 1;
  end if;
  if new.reviewer_id is null then
    if v_level = 'junior' then
      select user_id into new.reviewer_id from public.dev_team_members
       where level = 'senior' order by created_at limit 1;
    else
      new.reviewer_id := new.final_reviewer_id;
    end if;
  end if;
  return new;
end;
$fn$;

drop trigger if exists dev_subtasks_fill_reviewers on public.dev_subtasks;
create trigger dev_subtasks_fill_reviewers before insert or update of owner_id on public.dev_subtasks
  for each row execute function public.dev_fill_reviewers();

-- Backfill existing reviewer fields through the same rule.
update public.dev_subtasks set owner_id = owner_id;

-- Status is now task-owned, not a manually maintained feature property. Stop
-- the old roll-up trigger from writing legacy statuses back to dev_tasks.
drop trigger if exists dev_subtasks_rollup on public.dev_subtasks;

create or replace function public.dev_guard_task_update()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  if old.status is distinct from new.status and
     coalesce(current_setting('app.dev_transition', true), '') <> 'allowed' then
    raise exception 'use the task transition action';
  end if;
  if old.status is distinct from new.status then
    new.status_changed_at := now();
    if new.status <> 'blocked' then new.blocked_reason := null; end if;
    if new.status = 'live' then new.completed_at := coalesce(new.completed_at, now());
    else new.completed_at := null; end if;
  end if;
  return new;
end;
$fn$;

drop trigger if exists dev_subtasks_guard_update on public.dev_subtasks;
create trigger dev_subtasks_guard_update before update on public.dev_subtasks
  for each row execute function public.dev_guard_task_update();

create or replace function public.dev_transition_task(
  p_task uuid, p_to text, p_note text default null, p_blocked_reason text default null
) returns public.dev_subtasks
language plpgsql security definer set search_path = public as $fn$
declare
  v public.dev_subtasks;
  v_from text;
  v_actor uuid := auth.uid();
  v_level text;
  v_allowed boolean := false;
begin
  select * into v from public.dev_subtasks where id = p_task for update;
  if not found then raise exception 'task not found'; end if;
  if not public.dev_tasks_can_edit(v_actor) then raise exception 'not allowed'; end if;
  v_from := v.status;
  select level into v_level from public.dev_team_members where user_id = v.owner_id;
  v_allowed := case
    when v.status = 'backlog' and p_to = 'planned'
      then public.is_boss(v_actor) and coalesce(trim(v.acceptance_check), '') <> ''
    when v.status = 'planned' and p_to = 'in_progress' then v_actor = v.owner_id
    when v.status = 'in_progress' and p_to = 'blocked'
      then v_actor = v.owner_id and coalesce(trim(p_blocked_reason), '') <> ''
    when v.status = 'blocked' and p_to = 'in_progress' then v_actor = v.owner_id
    when v.status = 'in_progress' and p_to = 'dev_review'
      then v_actor = v.owner_id and v_level = 'junior'
    when v.status = 'in_progress' and p_to = 'your_review'
      then v_actor = v.owner_id and v_level = 'senior'
    when v.status = 'dev_review' and p_to = 'your_review'
      then v_actor = v.reviewer_id and v_actor <> v.owner_id
    when v.status in ('dev_review','your_review') and p_to = 'in_progress'
      then ((v.status = 'dev_review' and v_actor = v.reviewer_id)
         or (v.status = 'your_review' and v_actor = v.final_reviewer_id))
        and coalesce(trim(p_note), '') <> ''
    when v.status = 'your_review' and p_to = 'tested'
      then v_actor = v.final_reviewer_id and v_actor <> v.owner_id
    when v.status = 'tested' and p_to = 'live' then v_actor = v.owner_id
    else false
  end;
  if not v_allowed then
    if v.status = 'backlog' and p_to = 'planned' and coalesce(trim(v.acceptance_check), '') = '' then
      raise exception 'Add an acceptance check before scheduling';
    end if;
    raise exception 'that status change is not allowed';
  end if;
  perform set_config('app.dev_transition', 'allowed', true);
  update public.dev_subtasks
     set status = p_to,
         blocked_reason = case when p_to = 'blocked' then trim(p_blocked_reason) else null end
   where id = p_task returning * into v;
  insert into public.dev_task_notes(task_id, subtask_id, author_id, status_from, status_to, body)
  values (v.task_id, v.id, v_actor, v_from, p_to,
          nullif(trim(coalesce(p_note, p_blocked_reason, '')), ''));
  return v;
end;
$fn$;

create or replace function public.dev_move_feature(p_feature uuid, p_block uuid)
returns public.dev_tasks
language plpgsql security definer set search_path = public as $fn$
declare v public.dev_tasks; v_missing int;
begin
  if not public.is_boss(auth.uid()) then raise exception 'only the Boss plans blocks'; end if;
  if p_block is not null then
    select count(*) into v_missing from public.dev_subtasks
     where task_id = p_feature and coalesce(trim(acceptance_check), '') = '';
    if v_missing > 0 then raise exception 'Add an acceptance check before scheduling'; end if;
  end if;
  perform set_config('app.dev_planning', 'allowed', true);
  update public.dev_tasks
     set block_id = p_block,
         planned_task_count = case when p_block is null then null
           else (select count(*) from public.dev_subtasks where task_id = p_feature) end
   where id = p_feature returning * into v;
  if not found then raise exception 'feature not found'; end if;
  if p_block is not null then
    perform set_config('app.dev_transition', 'allowed', true);
    update public.dev_subtasks set status = 'planned'
     where task_id = p_feature and status = 'backlog';
  end if;
  return v;
end;
$fn$;

create or replace function public.dev_mark_duplicate(
  p_task uuid, p_duplicate uuid, p_note text default null
) returns public.dev_subtasks
language plpgsql security definer set search_path = public as $fn$
declare v public.dev_subtasks; v_from text; v_actor uuid := auth.uid();
begin
  if not exists (select 1 from public.dev_team_members
                  where user_id = v_actor and level = 'senior') then
    raise exception 'senior developer only';
  end if;
  select * into v from public.dev_subtasks where id = p_task for update;
  if not found or v.source <> 'bug_report' then raise exception 'bug not found'; end if;
  if not exists (select 1 from public.dev_subtasks where id = p_duplicate) then
    raise exception 'duplicate target not found';
  end if;
  v_from := v.status;
  perform set_config('app.dev_transition', 'allowed', true);
  update public.dev_subtasks
     set status = 'live', duplicate_of = p_duplicate, resolution = 'duplicate'
   where id = p_task returning * into v;
  insert into public.dev_task_notes(task_id, subtask_id, author_id, status_from, status_to, body)
  values (v.task_id, v.id, v_actor, v_from, 'live',
          coalesce(nullif(trim(p_note), ''), 'Closed as duplicate.'));
  return v;
end;
$fn$;

-- Activity and EOD --------------------------------------------
create or replace function public.dev_post_eod(p_entries jsonb, p_message text)
returns int language plpgsql security definer set search_path = public as $fn$
declare v_actor uuid := auth.uid(); v_item jsonb; v_count int := 0;
begin
  if not exists (select 1 from public.dev_team_members where user_id = v_actor) then
    raise exception 'developers only';
  end if;
  for v_item in select * from jsonb_array_elements(coalesce(p_entries, '[]'::jsonb)) loop
    if exists (select 1 from public.dev_subtasks s
               where s.id = (v_item->>'task_id')::uuid and s.owner_id = v_actor) then
      insert into public.dev_task_notes(task_id, subtask_id, author_id, body)
      select s.task_id, s.id, v_actor, 'EOD: ' || trim(v_item->>'body')
        from public.dev_subtasks s where s.id = (v_item->>'task_id')::uuid;
      v_count := v_count + 1;
    end if;
  end loop;
  -- Broadcasts is the existing cross-team announcement mechanism. Target the
  -- two developers and Boss so the update has the same audience as #dev.
  insert into public.broadcasts(author_id, title, body, target, target_roles, target_user_ids)
  select v_actor, 'Developer EOD · ' || to_char(now() at time zone 'Asia/Karachi', 'DD Mon'),
         trim(p_message), 'users', '{}', array_agg(p.id)
    from public.profiles p
   where p.is_active and p.deleted_at is null and p.role in ('boss','developer');
  return v_count;
end;
$fn$;

-- Company-wide bug intake ------------------------------------
insert into public.dev_tasks(title, description, priority, project_id, owner_id,
                             assigned_to, created_by, is_standing)
select 'Bugs', 'Issues reported by WurxOS employees.', 'normal', p.id,
       d.user_id, d.user_id, b.id, true
  from public.dev_projects p
  cross join lateral (select id from public.profiles where role = 'boss' order by created_at limit 1) b
  left join lateral (select user_id from public.dev_team_members order by level = 'senior' desc, created_at limit 1) d on true
 where p.stage = 'live'
   and not exists (select 1 from public.dev_tasks t where t.project_id = p.id and t.is_standing);

create or replace function public.dev_report_issue(
  p_page_url text, p_happened text, p_expected text default null
) returns uuid language plpgsql security definer set search_path = public as $fn$
declare v_feature uuid; v_task uuid; v_owner uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if coalesce(trim(p_happened), '') = '' then raise exception 'Tell us what happened'; end if;
  select t.id, t.owner_id into v_feature, v_owner
    from public.dev_tasks t join public.dev_projects p on p.id = t.project_id
   where t.is_standing and p.system_key = 'wurxos' limit 1;
  if v_feature is null then raise exception 'bug intake is not configured'; end if;
  insert into public.dev_subtasks(task_id, title, description, acceptance_check,
                                  priority, owner_id, source, reporter_id, page_url, expected)
  values (v_feature, left(trim(p_happened), 200), trim(p_happened),
          nullif(trim(coalesce(p_expected, '')), ''), 'normal', v_owner,
          'bug_report', auth.uid(), left(p_page_url, 1000), nullif(trim(coalesce(p_expected, '')), ''))
  returning id into v_task;
  return v_task;
end;
$fn$;

create or replace function public.dev_attach_issue_screenshot(p_task uuid, p_path text)
returns void language plpgsql security definer set search_path = public as $fn$
begin
  update public.dev_subtasks set screenshot_path = p_path
   where id = p_task and reporter_id = auth.uid() and source = 'bug_report';
  if not found then raise exception 'issue not found'; end if;
end;
$fn$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('dev-issue-screenshots', 'dev-issue-screenshots', false, 10485760,
        array['image/png','image/jpeg','image/webp','image/gif'])
on conflict (id) do nothing;

drop policy if exists dev_issue_screenshot_insert on storage.objects;
create policy dev_issue_screenshot_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'dev-issue-screenshots'
    and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists dev_issue_screenshot_select on storage.objects;
create policy dev_issue_screenshot_select on storage.objects for select to authenticated
  using (bucket_id = 'dev-issue-screenshots' and
    (public.dev_tasks_can_view(auth.uid()) or (storage.foldername(name))[1] = auth.uid()::text));

-- Visibility is now exactly Boss + developers. Bug reporters write through
-- the narrow RPC above and do not gain access to the private roadmap.
create or replace function public.dev_tasks_can_view(uid uuid)
returns boolean language sql security definer set search_path = public stable as $fn$
  select public.is_boss(uid) or exists (
    select 1 from public.profiles p
     where p.id = uid and p.is_active and p.deleted_at is null and p.role = 'developer'
  );
$fn$;

alter table public.dev_blocks enable row level security;
alter table public.dev_team_members enable row level security;
drop policy if exists dev_blocks_select on public.dev_blocks;
create policy dev_blocks_select on public.dev_blocks for select
  using (public.dev_tasks_can_view(auth.uid()));
drop policy if exists dev_team_members_select on public.dev_team_members;
create policy dev_team_members_select on public.dev_team_members for select
  using (public.dev_tasks_can_view(auth.uid()));
drop policy if exists dev_team_members_write on public.dev_team_members;
create policy dev_team_members_write on public.dev_team_members for all
  using (public.is_boss(auth.uid())) with check (public.is_boss(auth.uid()));

drop policy if exists dev_projects_write on public.dev_projects;
create policy dev_projects_write on public.dev_projects for all
  using (public.is_boss(auth.uid())) with check (public.is_boss(auth.uid()));

grant select on public.dev_blocks, public.dev_team_members to authenticated;
grant insert, update, delete on public.dev_team_members to authenticated;
grant execute on function public.dev_ensure_blocks(date) to authenticated;
grant execute on function public.dev_transition_task(uuid,text,text,text) to authenticated;
grant execute on function public.dev_move_feature(uuid,uuid) to authenticated;
grant execute on function public.dev_mark_duplicate(uuid,uuid,text) to authenticated;
grant execute on function public.dev_post_eod(jsonb,text) to authenticated;
grant execute on function public.dev_report_issue(text,text,text) to authenticated;
grant execute on function public.dev_attach_issue_screenshot(uuid,text) to authenticated;

-- Overview view used by Roadmap/List/Done. Feature status is rolled up from
-- its tasks using the artifact's explicit precedence.
drop view if exists public.dev_tasks_with_progress;
create view public.dev_tasks_with_progress with (security_invoker = true) as
select
  f.*,
  p.name as project_name, p.colour as project_colour, p.stage as project_stage,
  b.starts_on as block_starts_on, b.ends_on as block_ends_on,
  coalesce(s.total, 0) as subtask_total,
  coalesce(s.done, 0) as subtask_done,
  coalesce(s.live, 0) as subtask_live,
  coalesce(s.total, 0) as subtask_counted,
  case when coalesce(s.total, 0) = 0 then null
       else round(100.0 * s.done / s.total)::int end as progress_pct,
  coalesce(s.status_counts, '{}'::jsonb) as status_counts,
  case
    when coalesce(s.blocked, 0) > 0 then 'blocked'
    when coalesce(s.review, 0) > 0 then 'review'
    when coalesce(s.moving, 0) > 0 then 'in_progress'
    when coalesce(s.total, 0) > 0 and s.done = s.total then 'complete'
    else 'backlog'
  end as rollup_status,
  greatest(coalesce(s.total, 0) - coalesce(f.planned_task_count, s.total, 0), 0) as scope_added,
  false as is_overdue
from public.dev_tasks f
join public.dev_projects p on p.id = f.project_id
left join public.dev_blocks b on b.id = f.block_id
left join lateral (
  select coalesce(sum(n), 0) as total,
         coalesce(sum(n) filter (where status in ('tested','live')), 0) as done,
         coalesce(sum(n) filter (where status = 'live'), 0) as live,
         coalesce(sum(n) filter (where status = 'blocked'), 0) as blocked,
         coalesce(sum(n) filter (where status in ('dev_review','your_review')), 0) as review,
         coalesce(sum(n) filter (where status = 'in_progress'), 0) as moving,
         jsonb_object_agg(status, n) as status_counts
    from (select status, count(*) n from public.dev_subtasks d
           where d.task_id = f.id group by status) x
) s on true;
grant select on public.dev_tasks_with_progress to authenticated;

-- Notifications follow hand-offs, not every edit.
create or replace function public.dev_task_v2_notify()
returns trigger language plpgsql security definer set search_path = public as $fn$
declare v_actor uuid := auth.uid(); v_title text;
begin
  select title into v_title from public.dev_tasks where id = new.task_id;
  if tg_op = 'INSERT' and new.source = 'bug_report' then
    if new.owner_id is not null then
      perform public.emit_notification(new.owner_id, v_actor, 'dev_task', 'dev_task.bug_reported',
        'New issue reported', new.title, 'dev_task', new.id, '/dev-tasks/' || new.id);
    end if;
  elsif old.status is distinct from new.status then
    if new.status = 'dev_review' and new.reviewer_id is not null then
      perform public.emit_notification(new.reviewer_id, v_actor, 'dev_task', 'dev_task.dev_review',
        'Ready for developer review', new.title, 'dev_task', new.id, '/dev-tasks/' || new.id);
    elsif new.status = 'your_review' and new.final_reviewer_id is not null then
      perform public.emit_notification(new.final_reviewer_id, v_actor, 'dev_task', 'dev_task.boss_review',
        'Ready for your review', new.title, 'dev_task', new.id, '/dev-tasks/' || new.id);
    elsif new.status = 'in_progress' and old.status in ('dev_review','your_review') then
      perform public.emit_notification(new.owner_id, v_actor, 'dev_task', 'dev_task.sent_back',
        'Development task sent back', new.title, 'dev_task', new.id, '/dev-tasks/' || new.id);
    elsif new.status = 'live' and new.reporter_id is not null then
      perform public.emit_notification(new.reporter_id, v_actor, 'dev_task', 'dev_task.issue_live',
        'Your reported issue is fixed', new.title, 'dev_task', new.id, '/');
    end if;
  end if;
  return new;
end;
$fn$;

drop trigger if exists dev_subtasks_v2_notify on public.dev_subtasks;
create trigger dev_subtasks_v2_notify after insert or update of status on public.dev_subtasks
  for each row execute function public.dev_task_v2_notify();

-- Old parent notifications no longer describe the source of truth.
drop trigger if exists dev_tasks_notify on public.dev_tasks;
