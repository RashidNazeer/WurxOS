-- ============================================================
-- WurxOS v2 — BUNDLED pending migrations 019 → 038
-- Generated on 2026-04-16 for one-shot execution.
-- Safe to re-run: every migration uses IF NOT EXISTS / DROP IF EXISTS.
-- ============================================================


-- ============================================================
-- >>> 019_leave.sql
-- ============================================================
-- ============================================================
-- WurxOS v2 — Migration 019: Leave system (M-Leave)
--
-- Adds:
--   * leave_requests table (type/dates/status/reason/decision)
--   * leave_approver(uid) → reports_to, or Boss for root roles
--   * consumed_leaves(uid, year)  → { wfh, medical, emergency }
--   * RLS: requester manages own; approver + Boss see/decide
--   * Notification triggers on submit + decision
--
-- Safe to re-run.
-- ============================================================

-- --------------------------------------------------------------
-- 1. leave_requests
-- --------------------------------------------------------------
create table if not exists public.leave_requests (
  id            uuid primary key default gen_random_uuid(),
  requester_id  uuid not null references public.profiles(id) on delete cascade,
  type          text not null check (type in ('wfh', 'medical', 'emergency')),
  start_date    date not null,
  end_date      date not null,
  reason        text not null default '',
  status        text not null default 'pending'
                  check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by    uuid references public.profiles(id) on delete set null,
  decided_at    timestamptz,
  decision_note text,
  created_at    timestamptz not null default now(),
  check (end_date >= start_date)
);

create index if not exists leave_requests_requester_idx on public.leave_requests(requester_id, created_at desc);
create index if not exists leave_requests_status_idx    on public.leave_requests(status);
create index if not exists leave_requests_year_idx      on public.leave_requests(requester_id, extract(year from start_date));

-- --------------------------------------------------------------
-- 2. Helper: who approves leave for a given user?
--    Their reports_to if set; otherwise the first active Boss.
-- --------------------------------------------------------------
create or replace function public.leave_approver(uid uuid)
returns uuid
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(
    (select reports_to from public.profiles where id = uid and reports_to is not null),
    (select id from public.profiles where role = 'boss' and is_active = true order by created_at asc limit 1)
  );
$$;
grant execute on function public.leave_approver(uuid) to authenticated;

-- --------------------------------------------------------------
-- 3. Consumption summary — days of leave used this year
-- --------------------------------------------------------------
create or replace function public.consumed_leaves(p_user uuid, p_year int)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  with days as (
    select
      type,
      sum((end_date - start_date + 1))::int as d
    from public.leave_requests
    where requester_id = p_user
      and status = 'approved'
      and extract(year from start_date) = p_year
    group by type
  )
  select jsonb_build_object(
    'wfh',       coalesce((select d from days where type = 'wfh'), 0),
    'medical',   coalesce((select d from days where type = 'medical'), 0),
    'emergency', coalesce((select d from days where type = 'emergency'), 0)
  );
$$;
grant execute on function public.consumed_leaves(uuid, int) to authenticated;

-- --------------------------------------------------------------
-- 4. RLS
-- --------------------------------------------------------------
alter table public.leave_requests enable row level security;

-- Requester sees own; approver of the requester sees theirs; Boss/OL see all.
drop policy if exists "leave_select" on public.leave_requests;
create policy "leave_select"
  on public.leave_requests for select
  using (
    auth.uid() = requester_id
    or auth.uid() = public.leave_approver(requester_id)
    or public.is_boss(auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role in ('ol', 'developer') and p.is_active = true
    )
  );

-- Requester submits their own pending request.
drop policy if exists "leave_insert" on public.leave_requests;
create policy "leave_insert"
  on public.leave_requests for insert
  with check (
    auth.uid() = requester_id
    and status = 'pending'
  );

-- Requester may cancel own pending; approver / Boss may decide.
drop policy if exists "leave_update" on public.leave_requests;
create policy "leave_update"
  on public.leave_requests for update
  using (
    (auth.uid() = requester_id and status = 'pending')
    or auth.uid() = public.leave_approver(requester_id)
    or public.is_boss(auth.uid())
  )
  with check (
    (auth.uid() = requester_id and status in ('pending', 'cancelled'))
    or auth.uid() = public.leave_approver(requester_id)
    or public.is_boss(auth.uid())
  );

-- --------------------------------------------------------------
-- 5. Notification triggers — submit + decision
-- --------------------------------------------------------------
create or replace function public.leave_notify_on_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_approver uuid;
  v_name     text;
begin
  v_approver := public.leave_approver(new.requester_id);
  if v_approver is null or v_approver = new.requester_id then return new; end if;

  v_name := public.profile_display_name(new.requester_id);
  perform public.emit_notification(
    v_approver, new.requester_id, 'leave', 'leave.requested',
    'New leave request',
    v_name || ' requested ' || new.type || ' leave ('
      || to_char(new.start_date, 'Mon DD')
      || case when new.end_date <> new.start_date then ' – ' || to_char(new.end_date, 'Mon DD') else '' end
      || ')',
    'leave', new.id, '/leave/approvals'
  );
  return new;
end;
$$;

drop trigger if exists leave_notify_ai on public.leave_requests;
create trigger leave_notify_ai
  after insert on public.leave_requests
  for each row execute function public.leave_notify_on_insert();

create or replace function public.leave_notify_on_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_name  text;
begin
  if old.status is distinct from new.status and new.status in ('approved', 'rejected') then
    v_name := coalesce(public.profile_display_name(v_actor), 'Someone');
    perform public.emit_notification(
      new.requester_id, v_actor, 'leave', 'leave.' || new.status,
      'Leave ' || new.status,
      v_name || ' ' || new.status || ' your '
        || new.type || ' leave on ' || to_char(new.start_date, 'Mon DD'),
      'leave', new.id, '/leave'
    );
  end if;
  return new;
end;
$$;

drop trigger if exists leave_notify_au on public.leave_requests;
create trigger leave_notify_au
  after update of status on public.leave_requests
  for each row execute function public.leave_notify_on_update();


-- ============================================================
-- >>> 020_task_comments.sql
-- ============================================================
-- ============================================================
-- WurxOS v2 — Migration 020: Task comments
--
-- Adds:
--   * task_comments table (+ RLS: view follows can_view_task,
--     insert by anyone who can view, delete by author or Boss)
--   * Notification trigger: new comment → creator + assignee
--   * Adds task_comments to the supabase_realtime publication
--
-- Safe to re-run.
-- ============================================================

create table if not exists public.task_comments (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references public.tasks(id)   on delete cascade,
  author_id   uuid not null references public.profiles(id) on delete cascade,
  body        text not null check (length(trim(body)) > 0),
  created_at  timestamptz not null default now()
);

create index if not exists task_comments_task_idx    on public.task_comments(task_id, created_at desc);
create index if not exists task_comments_author_idx  on public.task_comments(author_id);

alter table public.task_comments enable row level security;

drop policy if exists "task_comments_select" on public.task_comments;
create policy "task_comments_select"
  on public.task_comments for select
  using (
    exists (
      select 1 from public.tasks t
      where t.id = task_comments.task_id
        and public.can_view_task(t.brand_id, t.assignee_id, t.created_by, auth.uid())
    )
  );

drop policy if exists "task_comments_insert" on public.task_comments;
create policy "task_comments_insert"
  on public.task_comments for insert
  with check (
    author_id = auth.uid()
    and exists (
      select 1 from public.tasks t
      where t.id = task_comments.task_id
        and public.can_view_task(t.brand_id, t.assignee_id, t.created_by, auth.uid())
    )
  );

drop policy if exists "task_comments_delete" on public.task_comments;
create policy "task_comments_delete"
  on public.task_comments for delete
  using (author_id = auth.uid() or public.is_boss(auth.uid()));

-- --------------------------------------------------------------
-- Notification: ping task creator + assignee (minus the actor)
-- --------------------------------------------------------------
create or replace function public.task_comments_notify()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task   public.tasks%rowtype;
  v_actor  text;
  v_body   text;
begin
  select * into v_task from public.tasks where id = new.task_id;
  if not found then return new; end if;

  v_actor := coalesce(public.profile_display_name(new.author_id), 'Someone');
  v_body  := v_actor || ' commented on "' || v_task.title || '"';

  -- Creator
  if v_task.created_by is not null and v_task.created_by <> new.author_id then
    perform public.emit_notification(
      v_task.created_by, new.author_id, 'task', 'task.commented',
      'New comment on your task', v_body,
      'task', v_task.id, '/tasks'
    );
  end if;

  -- Assignee (if different from creator and not the author)
  if v_task.assignee_id is not null
     and v_task.assignee_id <> new.author_id
     and v_task.assignee_id is distinct from v_task.created_by then
    perform public.emit_notification(
      v_task.assignee_id, new.author_id, 'task', 'task.commented',
      'New comment on your task', v_body,
      'task', v_task.id, '/tasks'
    );
  end if;

  return new;
end;
$$;

drop trigger if exists task_comments_notify_ai on public.task_comments;
create trigger task_comments_notify_ai
  after insert on public.task_comments
  for each row execute function public.task_comments_notify();

-- --------------------------------------------------------------
-- Realtime so comment thread live-updates
-- --------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'task_comments'
    ) then
      execute 'alter publication supabase_realtime add table public.task_comments';
    end if;
  end if;
end;
$$;


-- ============================================================
-- >>> 021_leave_coverage.sql
-- ============================================================
-- ============================================================
-- WurxOS v2 — Migration 021: Brand-coverage auto-reassignment
--
-- When a user's leave is approved, their active brand-tasks are
-- temporarily reassigned to a same-role teammate who's also
-- assigned to the same brand. Reverts when the leave ends,
-- is cancelled, or is rejected after approval.
--
-- Adds:
--   * tasks.covered_from_user_id  — original assignee while on coverage
--   * tasks.covered_for_leave_id  — which leave this coverage is tied to
--   * apply_leave_coverage(leave_id) / revert_leave_coverage(leave_id)
--   * Trigger on leave_requests status transitions
--   * pg_cron job: auto-revert when leave end_date has passed
--
-- Safe to re-run.
-- ============================================================

alter table public.tasks
  add column if not exists covered_from_user_id uuid references public.profiles(id) on delete set null,
  add column if not exists covered_for_leave_id uuid references public.leave_requests(id) on delete set null;

create index if not exists tasks_covered_leave_idx on public.tasks(covered_for_leave_id)
  where covered_for_leave_id is not null;

-- --------------------------------------------------------------
-- Helper: pick a covering user for (brand_id, original_user)
--   Same role, assigned to the same brand, active, not the original.
-- --------------------------------------------------------------
create or replace function public.pick_covering_user(p_brand uuid, p_original uuid)
returns uuid
language sql
security definer
set search_path = public
stable
as $$
  with o as (select role from public.profiles where id = p_original)
  select ba.user_id
  from public.brand_assignments ba
  join public.profiles p on p.id = ba.user_id
  where ba.brand_id = p_brand
    and ba.user_id <> p_original
    and p.is_active = true
    and p.role = (select role from o)
  order by ba.assigned_at asc
  limit 1;
$$;

-- --------------------------------------------------------------
-- apply_leave_coverage — find active tasks for the requester
-- and reassign to a covering teammate per-brand.
-- --------------------------------------------------------------
create or replace function public.apply_leave_coverage(p_leave uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_leave      public.leave_requests%rowtype;
  v_task       record;
  v_cover      uuid;
  v_count      int := 0;
begin
  select * into v_leave from public.leave_requests where id = p_leave;
  if not found or v_leave.status <> 'approved' then return 0; end if;

  for v_task in
    select * from public.tasks
    where assignee_id = v_leave.requester_id
      and status <> 'done'
      and brand_id is not null
      and covered_for_leave_id is null
  loop
    v_cover := public.pick_covering_user(v_task.brand_id, v_leave.requester_id);
    if v_cover is null then
      continue;  -- no teammate on this brand; leave the task with the original
    end if;
    update public.tasks
       set covered_from_user_id = v_leave.requester_id,
           covered_for_leave_id = p_leave,
           assignee_id = v_cover
     where id = v_task.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- --------------------------------------------------------------
-- revert_leave_coverage — put the covered tasks back to the
-- original assignee. Used by leave-cancel trigger + daily cron.
-- --------------------------------------------------------------
create or replace function public.revert_leave_coverage(p_leave uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  update public.tasks
     set assignee_id = covered_from_user_id,
         covered_from_user_id = null,
         covered_for_leave_id = null
   where covered_for_leave_id = p_leave
     and covered_from_user_id is not null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- --------------------------------------------------------------
-- Trigger on leave status transitions
-- --------------------------------------------------------------
create or replace function public.leave_coverage_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'approved' and old.status is distinct from 'approved' then
    perform public.apply_leave_coverage(new.id);
  elsif new.status in ('cancelled', 'rejected') and old.status = 'approved' then
    perform public.revert_leave_coverage(new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists leave_coverage_au on public.leave_requests;
create trigger leave_coverage_au
  after update of status on public.leave_requests
  for each row execute function public.leave_coverage_trigger();

-- --------------------------------------------------------------
-- Daily cron — revert coverage for leaves whose end_date has passed
-- --------------------------------------------------------------
create or replace function public.auto_revert_expired_coverages()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_leave record;
  v_total int := 0;
begin
  for v_leave in
    select distinct lr.id
    from public.leave_requests lr
    join public.tasks t on t.covered_for_leave_id = lr.id
    where lr.status = 'approved'
      and lr.end_date < current_date
  loop
    v_total := v_total + public.revert_leave_coverage(v_leave.id);
  end loop;
  return v_total;
end;
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      perform cron.unschedule('auto-revert-leave-coverage');
    exception when others then null;
    end;
  end if;
end;
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'auto-revert-leave-coverage',
      '15 0 * * *',    -- 00:15 UTC daily
      $cron$select public.auto_revert_expired_coverages();$cron$
    );
  end if;
end;
$$;


-- ============================================================
-- >>> 022_task_permissions.sql
-- ============================================================
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


-- ============================================================
-- >>> 023_responsibilities.sql
-- ============================================================
-- ============================================================
-- WurxOS v2 — Migration 023: Custom responsibilities
--
-- Adds profiles.responsibilities (text[]) — a free-text tag list
-- describing what each user is responsible for. Populated from
-- user_metadata by handle_new_user, editable self-or-Boss via
-- existing profiles RLS.
--
-- Safe to re-run.
-- ============================================================

alter table public.profiles
  add column if not exists responsibilities text[] not null default '{}';

-- Extend the signup trigger so create-user can seed the list.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_meta        jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_display     text  := coalesce(v_meta ->> 'display_name',
                                  split_part(new.email, '@', 1));
  v_role        text;
  v_created_by  uuid;
  v_reports_to  uuid;
  v_perm        jsonb := coalesce(v_meta -> 'permissions', '{}'::jsonb);
  v_resp        text[] := coalesce(
                    (select array_agg(value #>> '{}')
                     from jsonb_array_elements(
                       case jsonb_typeof(v_meta -> 'responsibilities')
                         when 'array' then v_meta -> 'responsibilities'
                         else '[]'::jsonb
                       end
                     ) value),
                    '{}'::text[]
                  );
begin
  -- If no profile exists yet, this is the very first user → Boss.
  if not exists (select 1 from public.profiles limit 1) then
    v_role := 'boss';
    v_created_by := null;
    v_reports_to := null;
  else
    v_role       := coalesce(v_meta ->> 'role', 'apc');
    v_created_by := nullif(v_meta ->> 'created_by', '')::uuid;
    v_reports_to := nullif(v_meta ->> 'reports_to', '')::uuid;
  end if;

  insert into public.profiles (
    id, email, display_name, role, created_by, reports_to,
    permissions, responsibilities
  ) values (
    new.id, new.email, v_display, v_role,
    v_created_by, v_reports_to, v_perm, v_resp
  );
  return new;
end;
$$;


-- ============================================================
-- >>> 024_brand_custom_fields.sql
-- ============================================================
-- ============================================================
-- WurxOS v2 — Migration 024: Brand custom fields
--
-- Free-form key/value metadata per brand (e.g. "Launch date",
-- "Commission %", "Target market"). RLS mirrors brands:
--   SELECT — anyone who can view the brand
--   WRITE  — anyone who can edit the brand (Boss/OL/owner TL)
--
-- Safe to re-run.
-- ============================================================

create table if not exists public.brand_custom_fields (
  id          uuid primary key default gen_random_uuid(),
  brand_id    uuid not null references public.brands(id) on delete cascade,
  field_name  text not null check (length(trim(field_name)) > 0),
  field_value text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (brand_id, field_name)
);

create index if not exists brand_custom_fields_brand_idx on public.brand_custom_fields(brand_id);

drop trigger if exists brand_custom_fields_touch on public.brand_custom_fields;
create trigger brand_custom_fields_touch
  before update on public.brand_custom_fields
  for each row execute function public.touch_updated_at();

alter table public.brand_custom_fields enable row level security;

drop policy if exists "bcf_select" on public.brand_custom_fields;
create policy "bcf_select"
  on public.brand_custom_fields for select
  using (
    exists (
      select 1 from public.brands b
      where b.id = brand_custom_fields.brand_id
        and public.can_view_brand(b.owner_id, b.id, auth.uid())
    )
  );

drop policy if exists "bcf_insert" on public.brand_custom_fields;
create policy "bcf_insert"
  on public.brand_custom_fields for insert
  with check (
    exists (
      select 1 from public.brands b
      where b.id = brand_custom_fields.brand_id
        and public.can_edit_brand(b.owner_id, auth.uid())
    )
  );

drop policy if exists "bcf_update" on public.brand_custom_fields;
create policy "bcf_update"
  on public.brand_custom_fields for update
  using (
    exists (
      select 1 from public.brands b
      where b.id = brand_custom_fields.brand_id
        and public.can_edit_brand(b.owner_id, auth.uid())
    )
  );

drop policy if exists "bcf_delete" on public.brand_custom_fields;
create policy "bcf_delete"
  on public.brand_custom_fields for delete
  using (
    exists (
      select 1 from public.brands b
      where b.id = brand_custom_fields.brand_id
        and public.can_edit_brand(b.owner_id, auth.uid())
    )
  );


-- ============================================================
-- >>> 025_brand_switch_requests.sql
-- ============================================================
-- ============================================================
-- WurxOS v2 — Migration 025: Brand TL switch-approval workflow
--
-- OLs can edit brands but cannot unilaterally change owner_id.
-- They open a brand_switch_requests row; Boss approves/rejects.
-- Approval triggers the actual owner_id update.
--
-- Adds:
--   * brand_switch_requests table + RLS
--   * brands BEFORE UPDATE trigger: block owner_id change except
--     by Boss or by the approval trigger itself (flagged via GUC).
--   * Notification triggers on submit + decision
--   * On approval: swap brands.owner_id
--
-- Safe to re-run.
-- ============================================================

-- --------------------------------------------------------------
-- 1. brand_switch_requests
-- --------------------------------------------------------------
create table if not exists public.brand_switch_requests (
  id             uuid primary key default gen_random_uuid(),
  brand_id       uuid not null references public.brands(id) on delete cascade,
  from_owner_id  uuid references public.profiles(id) on delete set null,
  to_owner_id    uuid not null references public.profiles(id) on delete cascade,
  requested_by   uuid not null references public.profiles(id) on delete set null,
  reason         text not null default '',
  status         text not null default 'pending'
                   check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by     uuid references public.profiles(id) on delete set null,
  decided_at     timestamptz,
  decision_note  text,
  created_at     timestamptz not null default now()
);

create index if not exists bsr_brand_idx    on public.brand_switch_requests(brand_id);
create index if not exists bsr_status_idx   on public.brand_switch_requests(status);
create index if not exists bsr_requester_idx on public.brand_switch_requests(requested_by);

alter table public.brand_switch_requests enable row level security;

-- SELECT — requester, Boss, and OL/dev see everything relevant
drop policy if exists "bsr_select" on public.brand_switch_requests;
create policy "bsr_select"
  on public.brand_switch_requests for select
  using (
    auth.uid() = requested_by
    or public.is_boss(auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role in ('ol', 'developer') and p.is_active = true
    )
  );

-- INSERT — OL (or Boss) only; must target a real active TL
drop policy if exists "bsr_insert" on public.brand_switch_requests;
create policy "bsr_insert"
  on public.brand_switch_requests for insert
  with check (
    requested_by = auth.uid()
    and status = 'pending'
    and (
      public.is_boss(auth.uid())
      or exists (
        select 1 from public.profiles p
        where p.id = auth.uid() and p.role = 'ol' and p.is_active = true
      )
    )
    and exists (
      select 1 from public.profiles tl
      where tl.id = to_owner_id and tl.role = 'tl' and tl.is_active = true
    )
  );

-- UPDATE — requester can cancel own pending; Boss decides
drop policy if exists "bsr_update" on public.brand_switch_requests;
create policy "bsr_update"
  on public.brand_switch_requests for update
  using (
    (auth.uid() = requested_by and status = 'pending')
    or public.is_boss(auth.uid())
  )
  with check (
    (auth.uid() = requested_by and status in ('pending', 'cancelled'))
    or public.is_boss(auth.uid())
  );

-- --------------------------------------------------------------
-- 2. Block non-Boss from changing brands.owner_id directly
-- --------------------------------------------------------------
create or replace function public.brands_block_owner_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bypass text := current_setting('wurxos.bypass_owner_guard', true);
begin
  if old.owner_id is distinct from new.owner_id
     and coalesce(v_bypass, 'off') <> 'on'
     and not public.is_boss(auth.uid()) then
    raise exception 'Only Boss can reassign a brand''s TL. Submit a switch request instead.'
      using errcode = 'P0007';
  end if;
  return new;
end;
$$;

drop trigger if exists brands_block_owner_change on public.brands;
create trigger brands_block_owner_change
  before update of owner_id on public.brands
  for each row execute function public.brands_block_owner_change();

-- --------------------------------------------------------------
-- 3. Notification + auto-apply on decision
-- --------------------------------------------------------------
create or replace function public.bsr_notify_on_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_boss uuid;
  v_brand text;
  v_name  text;
begin
  select brand_name into v_brand from public.brands where id = new.brand_id;
  v_name := coalesce(public.profile_display_name(new.requested_by), 'Someone');

  -- Notify every active Boss
  for v_boss in select id from public.profiles where role = 'boss' and is_active = true loop
    perform public.emit_notification(
      v_boss, new.requested_by, 'brand', 'brand.switch_requested',
      'Brand switch requested',
      v_name || ' proposed reassigning brand "' || coalesce(v_brand, '?') || '".',
      'brand', new.brand_id, '/boss/brand-switches'
    );
  end loop;
  return new;
end;
$$;

drop trigger if exists bsr_notify_ai on public.brand_switch_requests;
create trigger bsr_notify_ai
  after insert on public.brand_switch_requests
  for each row execute function public.bsr_notify_on_insert();

create or replace function public.bsr_apply_decision()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_brand text;
begin
  if old.status is distinct from new.status and new.status = 'approved' then
    -- Flip the owner through the guard using a per-statement GUC.
    perform set_config('wurxos.bypass_owner_guard', 'on', true);
    update public.brands set owner_id = new.to_owner_id where id = new.brand_id;
    perform set_config('wurxos.bypass_owner_guard', 'off', true);

    select brand_name into v_brand from public.brands where id = new.brand_id;
    perform public.emit_notification(
      new.requested_by, v_actor, 'brand', 'brand.switch_approved',
      'Brand switch approved',
      'Your switch request for "' || coalesce(v_brand, '?') || '" was approved.',
      'brand', new.brand_id, '/brands'
    );
  elsif old.status is distinct from new.status and new.status = 'rejected' then
    select brand_name into v_brand from public.brands where id = new.brand_id;
    perform public.emit_notification(
      new.requested_by, v_actor, 'brand', 'brand.switch_rejected',
      'Brand switch rejected',
      'Your switch request for "' || coalesce(v_brand, '?') || '" was rejected.',
      'brand', new.brand_id, '/brands'
    );
  end if;
  return new;
end;
$$;

drop trigger if exists bsr_decision_au on public.brand_switch_requests;
create trigger bsr_decision_au
  after update of status on public.brand_switch_requests
  for each row execute function public.bsr_apply_decision();


-- ============================================================
-- >>> 026_task_attachments.sql
-- ============================================================
-- ============================================================
-- WurxOS v2 — Migration 026: Task attachments
--
-- Adds:
--   * task_attachments table (metadata only; blob in Storage)
--   * Storage bucket 'task-attachments' (private, auth read/write)
--   * RLS mirroring can_view_task for viewers; uploader must be
--     able to view the task. Delete: uploader or Boss.
--
-- Safe to re-run.
-- ============================================================

create table if not exists public.task_attachments (
  id            uuid primary key default gen_random_uuid(),
  task_id       uuid not null references public.tasks(id)   on delete cascade,
  uploader_id   uuid not null references public.profiles(id) on delete cascade,
  file_name     text not null,
  file_path     text not null,   -- Supabase Storage object path
  file_size     int  not null default 0,
  mime_type     text not null default 'application/octet-stream',
  created_at    timestamptz not null default now(),
  unique (file_path)
);

create index if not exists task_attachments_task_idx on public.task_attachments(task_id, created_at desc);

alter table public.task_attachments enable row level security;

drop policy if exists "ta_select" on public.task_attachments;
create policy "ta_select"
  on public.task_attachments for select
  using (
    exists (
      select 1 from public.tasks t
      where t.id = task_attachments.task_id
        and public.can_view_task(t.brand_id, t.assignee_id, t.created_by, auth.uid())
    )
  );

drop policy if exists "ta_insert" on public.task_attachments;
create policy "ta_insert"
  on public.task_attachments for insert
  with check (
    uploader_id = auth.uid()
    and exists (
      select 1 from public.tasks t
      where t.id = task_attachments.task_id
        and public.can_view_task(t.brand_id, t.assignee_id, t.created_by, auth.uid())
    )
  );

drop policy if exists "ta_delete" on public.task_attachments;
create policy "ta_delete"
  on public.task_attachments for delete
  using (uploader_id = auth.uid() or public.is_boss(auth.uid()));

-- --------------------------------------------------------------
-- Storage bucket (private; client uses short-lived signed URLs).
-- --------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('task-attachments', 'task-attachments', false)
on conflict (id) do nothing;

drop policy if exists "ta_storage_read"   on storage.objects;
create policy "ta_storage_read"
  on storage.objects for select
  using (bucket_id = 'task-attachments' and auth.role() = 'authenticated');

drop policy if exists "ta_storage_write"  on storage.objects;
create policy "ta_storage_write"
  on storage.objects for insert
  with check (bucket_id = 'task-attachments' and auth.role() = 'authenticated');

drop policy if exists "ta_storage_delete" on storage.objects;
create policy "ta_storage_delete"
  on storage.objects for delete
  using (bucket_id = 'task-attachments' and auth.role() = 'authenticated');


-- ============================================================
-- >>> 027_notification_prefs.sql
-- ============================================================
-- ============================================================
-- WurxOS v2 — Migration 027: Notification preferences
--
-- Adds profiles.notification_prefs (jsonb) — per-category toggles
-- for push delivery. In-app delivery is always on; this only
-- gates the web-push dispatch.
--
-- Shape: { "<category>": { "push": bool }, ... }
-- Defaults: all categories push=true.
--
-- The push dispatch trigger consults these prefs before firing
-- the Edge Function.
-- ============================================================

alter table public.profiles
  add column if not exists notification_prefs jsonb not null
  default '{"task":{"push":true},"report":{"push":true},"brand":{"push":true},"leave":{"push":true},"paid_collab":{"push":true},"system":{"push":true}}'::jsonb;

-- Tighten the existing push-dispatch trigger to skip categories the
-- recipient has opted out of.
create or replace function public.notifications_dispatch_push()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url    text;
  v_secret text;
  v_pref   jsonb;
  v_push   bool;
begin
  begin
    select value into v_url    from public.app_config where key = 'send_push_url';
    select value into v_secret from public.app_config where key = 'send_push_secret';

    if v_url is null or v_url = '' then return new; end if;

    -- Check recipient's preference for this category (default: push on).
    select notification_prefs -> new.category into v_pref
      from public.profiles where id = new.recipient_id;
    v_push := coalesce((v_pref ->> 'push')::bool, true);
    if not v_push then return new; end if;

    perform net.http_post(
      url     := v_url,
      headers := jsonb_build_object(
        'Content-Type',    'application/json',
        'x-webhook-secret', coalesce(v_secret, '')
      ),
      body    := jsonb_build_object('notification_id', new.id)
    );
  exception when others then
    raise warning 'notifications_dispatch_push failed: %', sqlerrm;
  end;
  return new;
end;
$$;


-- ============================================================
-- >>> 028_audit_log.sql
-- ============================================================
-- ============================================================
-- WurxOS v2 — Migration 028: Audit log
--
-- Generic log of row-level changes on key tables. Each row records:
--   actor, entity_type, entity_id, action (insert/update/delete),
--   before jsonb, after jsonb, created_at.
--
-- Tracked tables: brands, tasks, reports, leave_requests,
--                 brand_switch_requests.
--
-- RLS: Boss / OL / Developer read all; no client writes (trigger
-- inserts via SECURITY DEFINER).
-- ============================================================

create table if not exists public.audit_log (
  id           uuid primary key default gen_random_uuid(),
  actor_id     uuid references public.profiles(id) on delete set null,
  entity_type  text not null,
  entity_id    uuid,
  action       text not null check (action in ('insert','update','delete')),
  before       jsonb,
  after        jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists audit_entity_idx  on public.audit_log(entity_type, entity_id, created_at desc);
create index if not exists audit_actor_idx   on public.audit_log(actor_id, created_at desc);
create index if not exists audit_created_idx on public.audit_log(created_at desc);

alter table public.audit_log enable row level security;

drop policy if exists "audit_select" on public.audit_log;
create policy "audit_select"
  on public.audit_log for select
  using (
    public.is_boss(auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true
    )
  );

drop policy if exists "audit_insert_block" on public.audit_log;
create policy "audit_insert_block"
  on public.audit_log for insert with check (false);

-- --------------------------------------------------------------
-- Generic row-change capture trigger
-- --------------------------------------------------------------
create or replace function public.audit_record()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entity text := TG_TABLE_NAME;
  v_id uuid;
begin
  if TG_OP = 'DELETE' then
    v_id := (to_jsonb(old) ->> 'id')::uuid;
    insert into public.audit_log(actor_id, entity_type, entity_id, action, before, after)
    values (auth.uid(), v_entity, v_id, 'delete', to_jsonb(old), null);
    return old;
  elsif TG_OP = 'UPDATE' then
    v_id := (to_jsonb(new) ->> 'id')::uuid;
    insert into public.audit_log(actor_id, entity_type, entity_id, action, before, after)
    values (auth.uid(), v_entity, v_id, 'update', to_jsonb(old), to_jsonb(new));
    return new;
  else
    v_id := (to_jsonb(new) ->> 'id')::uuid;
    insert into public.audit_log(actor_id, entity_type, entity_id, action, before, after)
    values (auth.uid(), v_entity, v_id, 'insert', null, to_jsonb(new));
    return new;
  end if;
end;
$$;

-- Attach to key tables
do $$
declare
  t text;
begin
  foreach t in array array['brands','tasks','reports','leave_requests','brand_switch_requests'] loop
    execute format('drop trigger if exists %I_audit on public.%I', t, t);
    execute format(
      'create trigger %I_audit after insert or update or delete on public.%I
         for each row execute function public.audit_record()',
      t, t
    );
  end loop;
end;
$$;


-- ============================================================
-- >>> 029_user_avatars.sql
-- ============================================================
-- ============================================================
-- WurxOS v2 — Migration 029: User avatars
--
-- Adds profiles.avatar_url (text) and a public 'avatars' storage
-- bucket (public read so <img src> works everywhere; auth write).
-- ============================================================

alter table public.profiles
  add column if not exists avatar_url text;

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

drop policy if exists "avatars_read" on storage.objects;
create policy "avatars_read"
  on storage.objects for select
  using (bucket_id = 'avatars');

drop policy if exists "avatars_write" on storage.objects;
create policy "avatars_write"
  on storage.objects for insert
  with check (bucket_id = 'avatars' and auth.role() = 'authenticated');

drop policy if exists "avatars_update" on storage.objects;
create policy "avatars_update"
  on storage.objects for update
  using (bucket_id = 'avatars' and auth.role() = 'authenticated');

drop policy if exists "avatars_delete" on storage.objects;
create policy "avatars_delete"
  on storage.objects for delete
  using (bucket_id = 'avatars' and auth.role() = 'authenticated');


-- ============================================================
-- >>> 030_attendance.sql
-- ============================================================
-- ============================================================
-- WurxOS v2 — Migration 030: Attendance
--
-- Adds:
--   * attendance table (one row per user per day)
--   * RPCs: clock_in, clock_out (APC/IPC → pending-approval, others → clocked-out),
--           start_break, end_break, approve_clock_out, reject_clock_out
--   * pg_cron: auto_clock_out_overdue_shifts() every 5 min (8h cap)
--   * RLS: self read/write; TL reads team (reports_to them); Boss/OL read all;
--          Boss/OL/TL decide approval for their reports
-- ============================================================

create table if not exists public.attendance (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  date           date not null,
  clock_in       timestamptz not null default now(),
  clock_out      timestamptz,
  location       text not null default 'wfh' check (location in ('wfh','bahria','lakecity','office')),
  status         text not null default 'clocked-in'
                   check (status in ('clocked-in','on-break','pending-approval','clocked-out')),
  breaks         jsonb not null default '[]'::jsonb,
  approval_by    uuid references public.profiles(id) on delete set null,
  approval_at    timestamptz,
  approval_note  text,
  auto_closed    boolean not null default false,
  total_work_ms  int,
  total_break_ms int,
  created_at     timestamptz not null default now(),
  unique (user_id, date)
);

create index if not exists attendance_user_date_idx on public.attendance(user_id, date desc);
create index if not exists attendance_status_idx    on public.attendance(status);

alter table public.attendance enable row level security;

-- SELECT: self; Boss/OL/dev all; TL → their direct reports
drop policy if exists "att_select" on public.attendance;
create policy "att_select"
  on public.attendance for select
  using (
    auth.uid() = user_id
    or public.is_boss(auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true
    )
    or exists (
      select 1 from public.profiles p
      where p.id = attendance.user_id and p.reports_to = auth.uid()
    )
  );

-- INSERT (clock-in) — self only
drop policy if exists "att_insert_self" on public.attendance;
create policy "att_insert_self"
  on public.attendance for insert
  with check (auth.uid() = user_id);

-- UPDATE — self (clock-out requests, breaks) OR approver (Boss/OL/TL-of-them)
drop policy if exists "att_update" on public.attendance;
create policy "att_update"
  on public.attendance for update
  using (
    auth.uid() = user_id
    or public.is_boss(auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true
    )
    or exists (
      select 1 from public.profiles p
      where p.id = attendance.user_id and p.reports_to = auth.uid()
    )
  );

-- --------------------------------------------------------------
-- RPCs
-- --------------------------------------------------------------
create or replace function public.att_clock_in(p_location text default 'wfh')
returns public.attendance
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_row  public.attendance;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  insert into public.attendance (user_id, date, location, status, clock_in)
  values (v_uid, current_date, p_location, 'clocked-in', now())
  on conflict (user_id, date) do update
    set status = 'clocked-in',
        clock_in = coalesce(public.attendance.clock_in, now()),
        location = excluded.location
    where public.attendance.clock_out is null
  returning * into v_row;
  return v_row;
end;
$$;
grant execute on function public.att_clock_in(text) to authenticated;

create or replace function public.att_request_clock_out()
returns public.attendance
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_role text;
  v_row  public.attendance;
  v_end  timestamptz := now();
  v_new_status text;
begin
  select role into v_role from public.profiles where id = v_uid;
  -- APC/IPC need approval; everyone else clocks out directly
  v_new_status := case when v_role in ('apc','ipc') then 'pending-approval' else 'clocked-out' end;

  update public.attendance
     set status = v_new_status,
         clock_out = case when v_new_status = 'clocked-out' then v_end else clock_out end,
         total_work_ms = case when v_new_status = 'clocked-out'
                              then greatest(0, extract(epoch from (v_end - clock_in))::int * 1000
                                   - coalesce(total_break_ms, 0))
                              else total_work_ms end
   where user_id = v_uid and date = current_date
   returning * into v_row;
  return v_row;
end;
$$;
grant execute on function public.att_request_clock_out() to authenticated;

create or replace function public.att_approve_clock_out(p_id uuid, p_approve boolean, p_note text default null)
returns public.attendance
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row  public.attendance;
  v_end  timestamptz := now();
begin
  if p_approve then
    update public.attendance
       set status      = 'clocked-out',
           clock_out   = v_end,
           approval_by = auth.uid(),
           approval_at = v_end,
           approval_note = p_note,
           total_work_ms = greatest(0, extract(epoch from (v_end - clock_in))::int * 1000
                                     - coalesce(total_break_ms, 0))
     where id = p_id
     returning * into v_row;
  else
    update public.attendance
       set status        = 'clocked-in',
           approval_by   = auth.uid(),
           approval_at   = v_end,
           approval_note = p_note
     where id = p_id
     returning * into v_row;
  end if;
  return v_row;
end;
$$;
grant execute on function public.att_approve_clock_out(uuid, boolean, text) to authenticated;

create or replace function public.att_start_break()
returns public.attendance
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_row  public.attendance;
  v_breaks jsonb;
begin
  select breaks into v_breaks from public.attendance
    where user_id = v_uid and date = current_date for update;
  v_breaks := coalesce(v_breaks, '[]'::jsonb)
              || jsonb_build_array(jsonb_build_object('start', now()));
  update public.attendance
     set breaks = v_breaks, status = 'on-break'
   where user_id = v_uid and date = current_date
   returning * into v_row;
  return v_row;
end;
$$;
grant execute on function public.att_start_break() to authenticated;

create or replace function public.att_end_break()
returns public.attendance
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_row  public.attendance;
  v_breaks jsonb;
  v_last jsonb;
  v_start timestamptz;
  v_add_ms int;
begin
  select breaks into v_breaks from public.attendance
    where user_id = v_uid and date = current_date for update;
  if v_breaks is null or jsonb_array_length(v_breaks) = 0 then
    return null;
  end if;
  v_last := v_breaks -> (jsonb_array_length(v_breaks) - 1);
  v_start := (v_last ->> 'start')::timestamptz;
  v_add_ms := greatest(0, extract(epoch from (now() - v_start))::int * 1000);
  v_breaks := jsonb_set(v_breaks, array[(jsonb_array_length(v_breaks) - 1)::text], v_last || jsonb_build_object('end', now()));
  update public.attendance
     set breaks = v_breaks,
         total_break_ms = coalesce(total_break_ms, 0) + v_add_ms,
         status = 'clocked-in'
   where user_id = v_uid and date = current_date
   returning * into v_row;
  return v_row;
end;
$$;
grant execute on function public.att_end_break() to authenticated;

-- --------------------------------------------------------------
-- Auto clock-out: cap any open shift older than 8 hours
-- --------------------------------------------------------------
create or replace function public.auto_clock_out_overdue_shifts()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.attendance;
  v_count int := 0;
  v_cap_end timestamptz;
begin
  for v_row in
    select * from public.attendance
    where clock_out is null
      and clock_in < now() - interval '8 hours'
      and status in ('clocked-in','on-break','pending-approval')
  loop
    v_cap_end := v_row.clock_in + interval '8 hours';
    update public.attendance
       set status = 'clocked-out',
           clock_out = v_cap_end,
           auto_closed = true,
           total_work_ms = greatest(0, 8 * 3600 * 1000 - coalesce(total_break_ms, 0))
     where id = v_row.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      perform cron.unschedule('auto-clock-out-overdue');
    exception when others then null;
    end;
  end if;
end;
$$;
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'auto-clock-out-overdue',
      '*/5 * * * *',
      $cron$select public.auto_clock_out_overdue_shifts();$cron$
    );
  end if;
end;
$$;

-- --------------------------------------------------------------
-- Notification: ping approver when APC/IPC requests clock-out
-- --------------------------------------------------------------
create or replace function public.att_notify_approval()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_approver uuid;
  v_name     text;
begin
  if old.status is distinct from new.status and new.status = 'pending-approval' then
    select reports_to into v_approver from public.profiles where id = new.user_id;
    if v_approver is null then
      select id into v_approver from public.profiles
       where role = 'boss' and is_active = true order by created_at asc limit 1;
    end if;
    if v_approver is not null and v_approver <> new.user_id then
      v_name := public.profile_display_name(new.user_id);
      perform public.emit_notification(
        v_approver, new.user_id, 'system', 'attendance.approval_requested',
        'Clock-out approval needed',
        v_name || ' requested clock-out approval.',
        'attendance', new.id, '/attendance'
      );
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists att_notify_au on public.attendance;
create trigger att_notify_au
  after update of status on public.attendance
  for each row execute function public.att_notify_approval();


-- ============================================================
-- >>> 031_resources.sql
-- ============================================================
-- ============================================================
-- WurxOS v2 — Migration 031: Resources
--
-- Shared links/images/videos. Either brand-scoped (follows
-- can_view_brand) or general-scoped (with visibility controls).
-- ============================================================

create table if not exists public.resources (
  id                uuid primary key default gen_random_uuid(),
  brand_id          uuid references public.brands(id) on delete cascade,
  type              text not null check (type in ('link','image','video','file')),
  name              text not null,
  url               text not null,
  description       text not null default '',
  visibility        text not null default 'office'
                      check (visibility in ('private','office','user','group')),
  visible_to_uid    uuid references public.profiles(id) on delete set null,
  visible_to_roles  text[] not null default '{}',
  created_by        uuid not null references public.profiles(id) on delete cascade,
  created_at        timestamptz not null default now()
);

create index if not exists resources_brand_idx    on public.resources(brand_id);
create index if not exists resources_creator_idx  on public.resources(created_by);

alter table public.resources enable row level security;

drop policy if exists "res_select" on public.resources;
create policy "res_select"
  on public.resources for select
  using (
    -- Creator / Boss / OL / Developer always
    created_by = auth.uid()
    or public.is_boss(auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true
    )
    -- Brand-scoped: visible to anyone who can see the brand
    or (brand_id is not null and exists (
      select 1 from public.brands b
      where b.id = resources.brand_id
        and public.can_view_brand(b.owner_id, b.id, auth.uid())
    ))
    -- General-scoped visibility
    or (brand_id is null and (
      (visibility = 'office')
      or (visibility = 'user'  and visible_to_uid = auth.uid())
      or (visibility = 'group' and exists (
           select 1 from public.profiles p
           where p.id = auth.uid() and p.role = any (visible_to_roles)
         ))
    ))
  );

drop policy if exists "res_insert" on public.resources;
create policy "res_insert"
  on public.resources for insert
  with check (created_by = auth.uid());

drop policy if exists "res_update" on public.resources;
create policy "res_update"
  on public.resources for update
  using (
    created_by = auth.uid()
    or public.is_boss(auth.uid())
    or (brand_id is not null and exists (
      select 1 from public.brands b
      where b.id = resources.brand_id and public.can_edit_brand(b.owner_id, auth.uid())
    ))
  );

drop policy if exists "res_delete" on public.resources;
create policy "res_delete"
  on public.resources for delete
  using (
    created_by = auth.uid()
    or public.is_boss(auth.uid())
    or (brand_id is not null and exists (
      select 1 from public.brands b
      where b.id = resources.brand_id and public.can_edit_brand(b.owner_id, auth.uid())
    ))
  );


-- ============================================================
-- >>> 032_performance.sql
-- ============================================================
-- ============================================================
-- WurxOS v2 — Migration 032: Performance
--
-- Adds:
--   * performance_ratings (user_id × month) with 6 metrics
--   * performance_flags (green/red achievements/issues)
--   * performance_warnings (formal warnings; 3 → termination risk)
-- ============================================================

create table if not exists public.performance_ratings (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles(id) on delete cascade,
  month             text not null,       -- "YYYY-MM"
  metrics           jsonb not null default '{}'::jsonb,
  overall_score     numeric generated always as (
    (
      coalesce((metrics ->> 'dailyTasksQuality')::numeric, 0) +
      coalesce((metrics ->> 'reporting')::numeric, 0) +
      coalesce((metrics ->> 'punctuality')::numeric, 0) +
      coalesce((metrics ->> 'overallWorkflow')::numeric, 0) +
      coalesce((metrics ->> 'responseTime')::numeric, 0) +
      coalesce((metrics ->> 'tasksProcessing')::numeric, 0)
    ) / 6.0
  ) stored,
  evaluated_by      uuid references public.profiles(id) on delete set null,
  updated_at        timestamptz not null default now(),
  unique (user_id, month)
);

create index if not exists perf_ratings_user_month_idx on public.performance_ratings(user_id, month desc);

create table if not exists public.performance_flags (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  type       text not null check (type in ('green','red')),
  severity   text not null default 'low' check (severity in ('low','medium','high','critical')),
  reason     text not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists perf_flags_user_idx on public.performance_flags(user_id, created_at desc);

create table if not exists public.performance_warnings (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  reason     text not null,
  severity   text not null default 'medium' check (severity in ('low','medium','high','critical')),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists perf_warnings_user_idx on public.performance_warnings(user_id, created_at desc);

-- RLS: self-read; Boss/OL/Developer full access; TL/PCTL read+write for direct reports.
alter table public.performance_ratings  enable row level security;
alter table public.performance_flags    enable row level security;
alter table public.performance_warnings enable row level security;

create or replace function public.can_eval_perf(p_target uuid, p_actor uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select
    public.is_boss(p_actor)
    or exists (select 1 from public.profiles p where p.id = p_actor and p.role in ('ol','developer') and p.is_active = true)
    or exists (select 1 from public.profiles p where p.id = p_target and p.reports_to = p_actor);
$$;
grant execute on function public.can_eval_perf(uuid, uuid) to authenticated;

-- SELECT (each table): self, Boss/OL/dev, or manager-of-target
do $$
declare t text;
begin
  foreach t in array array['performance_ratings','performance_flags','performance_warnings'] loop
    execute format('drop policy if exists "%s_select" on public.%I', t, t);
    execute format($p$create policy "%s_select" on public.%I for select using (
      auth.uid() = user_id
      or public.is_boss(auth.uid())
      or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
      or public.can_eval_perf(user_id, auth.uid())
    )$p$, t, t);
  end loop;
end;
$$;

-- INSERT/UPDATE/DELETE: can_eval_perf(target, actor)
do $$
declare t text;
begin
  foreach t in array array['performance_ratings','performance_flags','performance_warnings'] loop
    execute format('drop policy if exists "%s_write" on public.%I', t, t);
    execute format($p$create policy "%s_write" on public.%I for all using (public.can_eval_perf(user_id, auth.uid())) with check (public.can_eval_perf(user_id, auth.uid()))$p$, t, t);
  end loop;
end;
$$;


-- ============================================================
-- >>> 033_incentives.sql
-- ============================================================
-- ============================================================
-- WurxOS v2 — Migration 033: Bonus & Incentives
--
-- One row per (user, month). Line items are stored inline as jsonb
-- arrays (incentives / bonuses). Each item:
--   { id, text, amount, targetValue, achievedValue, suffix, completed }
--
-- Auto-complete rule: achieved/target ≥ 0.9 → completed = true
-- (applied client-side on save; kept as a flag in the row).
-- ============================================================

create table if not exists public.incentives (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.profiles(id) on delete cascade,
  month               text not null,   -- "YYYY-MM"
  basic_salary        numeric not null default 0,
  incentives          jsonb not null default '[]'::jsonb,
  bonuses             jsonb not null default '[]'::jsonb,
  verified            boolean not null default false,
  payout_cleared      boolean not null default false,
  last_updated_by     uuid references public.profiles(id) on delete set null,
  updated_at          timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  unique (user_id, month)
);

create index if not exists incentives_user_month_idx on public.incentives(user_id, month desc);

alter table public.incentives enable row level security;

-- SELECT: self, Boss, OL/dev, manager (reports_to)
drop policy if exists "inc_select" on public.incentives;
create policy "inc_select"
  on public.incentives for select
  using (
    auth.uid() = user_id
    or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
    or exists (select 1 from public.profiles p where p.id = incentives.user_id and p.reports_to = auth.uid())
  );

-- INSERT / UPDATE: Boss, OL/dev full; the target user may UPDATE their row
-- (to record progress on achievedValue) but may NOT flip verified/payout_cleared.
drop policy if exists "inc_insert" on public.incentives;
create policy "inc_insert"
  on public.incentives for insert
  with check (
    public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
  );

drop policy if exists "inc_update" on public.incentives;
create policy "inc_update"
  on public.incentives for update
  using (
    auth.uid() = user_id
    or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
  )
  with check (
    auth.uid() = user_id
    or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
  );

-- Guard: non-admin users cannot flip verified / payout_cleared / basic_salary
create or replace function public.incentives_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_admin bool := public.is_boss(auth.uid()) or exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true
  );
begin
  if not v_is_admin then
    if new.verified       is distinct from old.verified       then raise exception 'only admin can verify'; end if;
    if new.payout_cleared is distinct from old.payout_cleared then raise exception 'only admin can clear payout'; end if;
    if new.basic_salary   is distinct from old.basic_salary   then raise exception 'only admin can edit salary'; end if;
  end if;
  return new;
end;
$$;

drop trigger if exists incentives_guard on public.incentives;
create trigger incentives_guard
  before update on public.incentives
  for each row execute function public.incentives_guard();


-- ============================================================
-- >>> 034_broadcasts.sql
-- ============================================================
-- ============================================================
-- WurxOS v2 — Migration 034: Broadcasts
--
-- Boss / OL / Developer compose announcements that fan out to
-- every matching user via emit_notification. Optional scheduling
-- via scheduled_for + pg_cron minute-level dispatcher.
-- ============================================================

create table if not exists public.broadcasts (
  id             uuid primary key default gen_random_uuid(),
  author_id      uuid references public.profiles(id) on delete set null,
  title          text not null,
  body           text not null default '',
  target         text not null default 'all'
                   check (target in ('all','role','brand')),
  target_roles   text[] not null default '{}',
  target_brand_id uuid references public.brands(id) on delete set null,
  scheduled_for  timestamptz,
  sent_at        timestamptz,
  sent_count     int,
  created_at     timestamptz not null default now()
);

create index if not exists broadcasts_scheduled_idx
  on public.broadcasts(scheduled_for)
  where sent_at is null and scheduled_for is not null;

alter table public.broadcasts enable row level security;

drop policy if exists "bc_select" on public.broadcasts;
create policy "bc_select"
  on public.broadcasts for select
  using (
    public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
    or author_id = auth.uid()
  );

drop policy if exists "bc_insert" on public.broadcasts;
create policy "bc_insert"
  on public.broadcasts for insert
  with check (
    author_id = auth.uid()
    and (
      public.is_boss(auth.uid())
      or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
    )
  );

-- Fan-out helper — called by trigger on insert (immediate) or cron (scheduled)
create or replace function public.dispatch_broadcast(p_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.broadcasts;
  v_uid uuid;
  v_count int := 0;
begin
  select * into v_row from public.broadcasts where id = p_id;
  if not found or v_row.sent_at is not null then return 0; end if;

  for v_uid in
    select p.id from public.profiles p
    where p.is_active = true
      and (
        v_row.target = 'all'
        or (v_row.target = 'role'  and p.role = any (v_row.target_roles))
        or (v_row.target = 'brand' and (
              p.id = (select owner_id from public.brands where id = v_row.target_brand_id)
              or exists (select 1 from public.brand_assignments ba where ba.brand_id = v_row.target_brand_id and ba.user_id = p.id)
            ))
      )
      and p.id <> coalesce(v_row.author_id, '00000000-0000-0000-0000-000000000000')
  loop
    perform public.emit_notification(
      v_uid, v_row.author_id, 'system', 'broadcast',
      v_row.title, v_row.body, 'broadcast', v_row.id, '/broadcasts'
    );
    v_count := v_count + 1;
  end loop;

  update public.broadcasts set sent_at = now(), sent_count = v_count where id = p_id;
  return v_count;
end;
$$;

create or replace function public.broadcasts_dispatch_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.scheduled_for is null or new.scheduled_for <= now() then
    perform public.dispatch_broadcast(new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists broadcasts_dispatch_ai on public.broadcasts;
create trigger broadcasts_dispatch_ai
  after insert on public.broadcasts
  for each row execute function public.broadcasts_dispatch_trigger();

-- Cron: pick up any scheduled broadcasts whose time has come
create or replace function public.dispatch_scheduled_broadcasts()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_total int := 0;
begin
  for v_id in
    select id from public.broadcasts
    where sent_at is null
      and scheduled_for is not null
      and scheduled_for <= now()
  loop
    v_total := v_total + public.dispatch_broadcast(v_id);
  end loop;
  return v_total;
end;
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      perform cron.unschedule('dispatch-scheduled-broadcasts');
    exception when others then null;
    end;
  end if;
end;
$$;
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('dispatch-scheduled-broadcasts', '* * * * *',
      $cron$select public.dispatch_scheduled_broadcasts();$cron$);
  end if;
end;
$$;


-- ============================================================
-- >>> 035_reminders.sql
-- ============================================================
-- ============================================================
-- WurxOS v2 — Migration 035: Reminders
--
-- User-set reminders. pg_cron every minute picks up due rows and
-- fires an emit_notification to the owner, marking sent_at.
-- ============================================================

create table if not exists public.reminders (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  title       text not null,
  body        text not null default '',
  remind_at   timestamptz not null,
  link        text not null default '/notifications',
  sent_at     timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists reminders_user_idx on public.reminders(user_id, remind_at desc);
create index if not exists reminders_due_idx  on public.reminders(remind_at) where sent_at is null;

alter table public.reminders enable row level security;

drop policy if exists "rem_select" on public.reminders;
create policy "rem_select" on public.reminders for select
  using (auth.uid() = user_id);

drop policy if exists "rem_insert" on public.reminders;
create policy "rem_insert" on public.reminders for insert
  with check (auth.uid() = user_id);

drop policy if exists "rem_update" on public.reminders;
create policy "rem_update" on public.reminders for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "rem_delete" on public.reminders;
create policy "rem_delete" on public.reminders for delete
  using (auth.uid() = user_id);

create or replace function public.fire_due_reminders()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.reminders;
  v_count int := 0;
begin
  for v_row in
    select * from public.reminders
    where sent_at is null and remind_at <= now()
    order by remind_at asc
    limit 500
  loop
    perform public.emit_notification(
      v_row.user_id, v_row.user_id, 'system', 'reminder',
      v_row.title, v_row.body, 'reminder', v_row.id, v_row.link
    );
    update public.reminders set sent_at = now() where id = v_row.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- NOTE: emit_notification skips when recipient = actor. Override for
-- reminders by inserting directly (bypasses the self-skip).
create or replace function public.fire_due_reminders()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.reminders;
  v_count int := 0;
begin
  for v_row in
    select * from public.reminders
    where sent_at is null and remind_at <= now()
    order by remind_at asc
    limit 500
  loop
    insert into public.notifications (
      recipient_id, actor_id, category, action, title, body,
      entity_type, entity_id, link
    ) values (
      v_row.user_id, null, 'system', 'reminder', v_row.title, v_row.body,
      'reminder', v_row.id, v_row.link
    );
    update public.reminders set sent_at = now() where id = v_row.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      perform cron.unschedule('fire-due-reminders');
    exception when others then null;
    end;
  end if;
end;
$$;
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('fire-due-reminders', '* * * * *',
      $cron$select public.fire_due_reminders();$cron$);
  end if;
end;
$$;


-- ============================================================
-- >>> 036_knowledge_base.sql
-- ============================================================
-- ============================================================
-- WurxOS v2 — Migration 036: Knowledge base
--
-- Articles (title + markdown-ish body) grouped by category.
-- Visibility: office (all), role (role list), private (author).
-- Boss / OL / Developer full CRUD; everyone read (per visibility);
-- authors can edit/delete their own.
-- ============================================================

create table if not exists public.kb_articles (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  body        text not null default '',
  category    text not null default 'General',
  visibility  text not null default 'office'
                check (visibility in ('private','office','role')),
  visible_to_roles text[] not null default '{}',
  tags        text[] not null default '{}',
  created_by  uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists kb_category_idx on public.kb_articles(category);
create index if not exists kb_tags_idx     on public.kb_articles using gin(tags);

drop trigger if exists kb_touch on public.kb_articles;
create trigger kb_touch before update on public.kb_articles
  for each row execute function public.touch_updated_at();

alter table public.kb_articles enable row level security;

drop policy if exists "kb_select" on public.kb_articles;
create policy "kb_select" on public.kb_articles for select
  using (
    created_by = auth.uid()
    or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
    or visibility = 'office'
    or (visibility = 'role' and exists (
        select 1 from public.profiles p
        where p.id = auth.uid() and p.role = any (visible_to_roles)
    ))
  );

drop policy if exists "kb_insert" on public.kb_articles;
create policy "kb_insert" on public.kb_articles for insert
  with check (created_by = auth.uid());

drop policy if exists "kb_update" on public.kb_articles;
create policy "kb_update" on public.kb_articles for update
  using (
    created_by = auth.uid()
    or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
  );

drop policy if exists "kb_delete" on public.kb_articles;
create policy "kb_delete" on public.kb_articles for delete
  using (
    created_by = auth.uid()
    or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
  );


-- ============================================================
-- >>> 037_chat.sql
-- ============================================================
-- ============================================================
-- WurxOS v2 — Migration 037: Chat (channels, members, messages)
--
-- Types:
--   * dm       — exactly 2 members
--   * group    — any members (created by Boss/OL)
--   * role     — pseudo-auto; rows created per role, every user with
--                that role is implicit-member (queried via role_key)
--
-- For simplicity v1 ships with dm + group only (role-channel can be
-- added later).
-- ============================================================

create table if not exists public.chat_channels (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null check (kind in ('dm','group')),
  name       text,                        -- null for DM; display name for group
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.chat_members (
  channel_id uuid not null references public.chat_channels(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  joined_at  timestamptz not null default now(),
  last_read_at timestamptz not null default now(),
  primary key (channel_id, user_id)
);

create index if not exists chat_members_user_idx on public.chat_members(user_id);

create table if not exists public.chat_messages (
  id         uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.chat_channels(id) on delete cascade,
  author_id  uuid not null references public.profiles(id) on delete cascade,
  body       text not null,
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_channel_idx on public.chat_messages(channel_id, created_at desc);

-- RLS
alter table public.chat_channels enable row level security;
alter table public.chat_members  enable row level security;
alter table public.chat_messages enable row level security;

-- Member check helper
create or replace function public.is_chat_member(p_channel uuid, p_uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (select 1 from public.chat_members where channel_id = p_channel and user_id = p_uid);
$$;
grant execute on function public.is_chat_member(uuid, uuid) to authenticated;

-- channels: members can SELECT; creator (or Boss) can INSERT/UPDATE/DELETE
drop policy if exists "chan_select" on public.chat_channels;
create policy "chan_select" on public.chat_channels for select
  using (public.is_chat_member(id, auth.uid()) or public.is_boss(auth.uid()));

drop policy if exists "chan_insert" on public.chat_channels;
create policy "chan_insert" on public.chat_channels for insert
  with check (created_by = auth.uid());

drop policy if exists "chan_update" on public.chat_channels;
create policy "chan_update" on public.chat_channels for update
  using (created_by = auth.uid() or public.is_boss(auth.uid()));

drop policy if exists "chan_delete" on public.chat_channels;
create policy "chan_delete" on public.chat_channels for delete
  using (created_by = auth.uid() or public.is_boss(auth.uid()));

-- members: you see members of channels you're in; you can add yourself
-- on channel creation (via SECURITY DEFINER function); creator/Boss manage.
drop policy if exists "mem_select" on public.chat_members;
create policy "mem_select" on public.chat_members for select
  using (public.is_chat_member(channel_id, auth.uid()) or public.is_boss(auth.uid()));

drop policy if exists "mem_insert" on public.chat_members;
create policy "mem_insert" on public.chat_members for insert
  with check (
    user_id = auth.uid()
    or public.is_boss(auth.uid())
    or exists (select 1 from public.chat_channels c where c.id = chat_members.channel_id and c.created_by = auth.uid())
  );

drop policy if exists "mem_update" on public.chat_members;
create policy "mem_update" on public.chat_members for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "mem_delete" on public.chat_members;
create policy "mem_delete" on public.chat_members for delete
  using (
    user_id = auth.uid()
    or public.is_boss(auth.uid())
    or exists (select 1 from public.chat_channels c where c.id = chat_members.channel_id and c.created_by = auth.uid())
  );

-- messages: member read; member write (as self); author delete; Boss delete
drop policy if exists "msg_select" on public.chat_messages;
create policy "msg_select" on public.chat_messages for select
  using (public.is_chat_member(channel_id, auth.uid()));

drop policy if exists "msg_insert" on public.chat_messages;
create policy "msg_insert" on public.chat_messages for insert
  with check (author_id = auth.uid() and public.is_chat_member(channel_id, auth.uid()));

drop policy if exists "msg_delete" on public.chat_messages;
create policy "msg_delete" on public.chat_messages for delete
  using (author_id = auth.uid() or public.is_boss(auth.uid()));

-- RPC: open-or-create DM with another user (idempotent)
create or replace function public.chat_open_dm(p_other uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_self uuid := auth.uid();
  v_existing uuid;
  v_id uuid;
begin
  if v_self is null or p_other is null or v_self = p_other then
    raise exception 'invalid DM target';
  end if;

  -- Any channel where both are members (dm only)
  select c.id into v_existing
  from public.chat_channels c
  join public.chat_members a on a.channel_id = c.id and a.user_id = v_self
  join public.chat_members b on b.channel_id = c.id and b.user_id = p_other
  where c.kind = 'dm'
  limit 1;
  if v_existing is not null then return v_existing; end if;

  insert into public.chat_channels (kind, created_by) values ('dm', v_self) returning id into v_id;
  insert into public.chat_members (channel_id, user_id) values (v_id, v_self), (v_id, p_other);
  return v_id;
end;
$$;
grant execute on function public.chat_open_dm(uuid) to authenticated;

-- RPC: create a group channel with initial members
create or replace function public.chat_create_group(p_name text, p_members uuid[])
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_self uuid := auth.uid();
  v_id uuid;
  v_member uuid;
begin
  if v_self is null then raise exception 'not authenticated'; end if;
  insert into public.chat_channels (kind, name, created_by)
  values ('group', nullif(trim(p_name), ''), v_self)
  returning id into v_id;

  insert into public.chat_members (channel_id, user_id) values (v_id, v_self);
  foreach v_member in array coalesce(p_members, '{}') loop
    if v_member <> v_self then
      insert into public.chat_members (channel_id, user_id) values (v_id, v_member)
      on conflict do nothing;
    end if;
  end loop;
  return v_id;
end;
$$;
grant execute on function public.chat_create_group(text, uuid[]) to authenticated;

-- Realtime publication
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'chat_messages') then
      execute 'alter publication supabase_realtime add table public.chat_messages';
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'chat_members') then
      execute 'alter publication supabase_realtime add table public.chat_members';
    end if;
  end if;
end;
$$;

-- Notification trigger: ping other members on new messages (in-app only;
-- push gated by notification_prefs.system)
create or replace function public.chat_notify_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid;
  v_actor_name text;
  v_channel_name text;
begin
  v_actor_name := public.profile_display_name(new.author_id);
  select coalesce(name, 'Direct message') into v_channel_name
    from public.chat_channels where id = new.channel_id;

  for v_uid in
    select user_id from public.chat_members
    where channel_id = new.channel_id and user_id <> new.author_id
  loop
    perform public.emit_notification(
      v_uid, new.author_id, 'system', 'chat.message',
      v_actor_name || ' · ' || v_channel_name,
      left(new.body, 140),
      'chat', new.channel_id, '/chat'
    );
  end loop;
  return new;
end;
$$;

drop trigger if exists chat_notify_ai on public.chat_messages;
create trigger chat_notify_ai
  after insert on public.chat_messages
  for each row execute function public.chat_notify_message();


-- ============================================================
-- >>> 038_performance_composite.sql
-- ============================================================
-- ============================================================
-- WurxOS v2 — Migration 038: Performance composite & config
--
-- Extends migration 032 to match v1's 4-pillar composite model:
--   * performance_config singleton (Boss-editable weights, thresholds,
--     min attendance days, flag point values)
--   * get_performance_composite(user, month) -> 4 pillar scores +
--     composite score + level classification
--   * get_performance_overview(month, role_filter) -> list for team view
--   * notifications: fire when a rating / flag / warning is issued
-- ============================================================

-- ------------------------------------------------------------
-- 1. Config singleton
-- ------------------------------------------------------------
create table if not exists public.performance_config (
  id                    int primary key default 1,
  -- pillar weights (must sum to 100; UI enforces)
  weight_performance    numeric not null default 40,
  weight_incentives     numeric not null default 25,
  weight_attendance     numeric not null default 20,
  weight_flags          numeric not null default 15,
  -- attendance baseline
  min_attendance_days   int not null default 22,
  -- level thresholds (composite 0-100)
  threshold_promotion   numeric not null default 90,
  threshold_good        numeric not null default 70,
  threshold_warning     numeric not null default 50,
  -- flag point values (added/subtracted from flags pillar base 70)
  flag_pts_low          numeric not null default 3,
  flag_pts_medium       numeric not null default 5,
  flag_pts_high         numeric not null default 8,
  flag_pts_critical     numeric not null default 12,
  updated_by            uuid references public.profiles(id) on delete set null,
  updated_at            timestamptz not null default now(),
  constraint performance_config_single_row check (id = 1)
);

insert into public.performance_config (id) values (1) on conflict (id) do nothing;

alter table public.performance_config enable row level security;

drop policy if exists "perf_config_select" on public.performance_config;
create policy "perf_config_select"
  on public.performance_config for select
  using (auth.uid() is not null);

drop policy if exists "perf_config_write" on public.performance_config;
create policy "perf_config_write"
  on public.performance_config for update
  using (public.is_boss(auth.uid()))
  with check (public.is_boss(auth.uid()));

-- ------------------------------------------------------------
-- 2. Pillar computations
-- ------------------------------------------------------------

-- Incentives pillar: % of items marked completed (incentives + bonuses).
-- If no items, returns 0 (matches v1 behaviour).
create or replace function public.perf_incentives_score(p_user uuid, p_month text)
returns numeric
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_done int := 0;
  v_total int := 0;
  v_row public.incentives%rowtype;
begin
  select * into v_row from public.incentives where user_id = p_user and month = p_month;
  if not found then return 0; end if;

  select
    coalesce(
      (select count(*) from jsonb_array_elements(v_row.incentives) x where (x->>'completed')::bool),
      0
    ) +
    coalesce(
      (select count(*) from jsonb_array_elements(v_row.bonuses) x where (x->>'completed')::bool),
      0
    )
  into v_done;

  v_total := coalesce(jsonb_array_length(v_row.incentives), 0)
           + coalesce(jsonb_array_length(v_row.bonuses), 0);

  if v_total = 0 then return 0; end if;
  return round((v_done::numeric / v_total) * 100, 1);
end;
$$;
grant execute on function public.perf_incentives_score(uuid, text) to authenticated;

-- Attendance pillar: daysPresent / minAttendanceDays * 100 (capped 100).
-- "Present" = attendance row for the user/month that reached status
-- clocked-out or is still active (counts partial day). Auto-closed days count.
create or replace function public.perf_attendance_score(p_user uuid, p_month text)
returns numeric
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_min int;
  v_days int;
  v_start date := (p_month || '-01')::date;
  v_end   date := (p_month || '-01')::date + interval '1 month';
begin
  select min_attendance_days into v_min from public.performance_config where id = 1;
  if v_min is null or v_min = 0 then v_min := 22; end if;

  select count(distinct date) into v_days
    from public.attendance
   where user_id = p_user
     and date >= v_start and date < v_end;

  return least(100, round((v_days::numeric / v_min) * 100, 1));
end;
$$;
grant execute on function public.perf_attendance_score(uuid, text) to authenticated;

-- Flags pillar: base 70 + green pts - red pts, clamped to 0-100.
-- Only flags created in the target month are counted.
create or replace function public.perf_flags_score(p_user uuid, p_month text)
returns numeric
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_low      numeric;
  v_med      numeric;
  v_high     numeric;
  v_crit     numeric;
  v_green    numeric := 0;
  v_red      numeric := 0;
  v_start    timestamptz := (p_month || '-01')::timestamptz;
  v_end      timestamptz := ((p_month || '-01')::date + interval '1 month')::timestamptz;
  r          record;
begin
  select flag_pts_low, flag_pts_medium, flag_pts_high, flag_pts_critical
    into v_low, v_med, v_high, v_crit
    from public.performance_config where id = 1;

  for r in
    select type, severity, count(*) as n
      from public.performance_flags
     where user_id = p_user
       and created_at >= v_start and created_at < v_end
     group by type, severity
  loop
    declare v_pts numeric;
    begin
      v_pts := case r.severity
        when 'low'      then coalesce(v_low, 3)
        when 'medium'   then coalesce(v_med, 5)
        when 'high'     then coalesce(v_high, 8)
        when 'critical' then coalesce(v_crit, 12)
        else 0
      end;
      if r.type = 'green' then
        v_green := v_green + v_pts * r.n;
      else
        v_red := v_red + v_pts * r.n;
      end if;
    end;
  end loop;

  return greatest(0, least(100, 70 + v_green - v_red));
end;
$$;
grant execute on function public.perf_flags_score(uuid, text) to authenticated;

-- Classify composite into a level label
create or replace function public.perf_level(p_score numeric)
returns text
language sql
stable
as $$
  select case
    when p_score is null then 'not_rated'
    when p_score >= (select threshold_promotion from public.performance_config where id = 1) then 'promotion'
    when p_score >= (select threshold_good      from public.performance_config where id = 1) then 'good'
    when p_score >= (select threshold_warning   from public.performance_config where id = 1) then 'warning'
    else 'termination'
  end;
$$;
grant execute on function public.perf_level(numeric) to authenticated;

-- ------------------------------------------------------------
-- 3. Composite RPC (per-user, per-month)
-- ------------------------------------------------------------
create or replace function public.get_performance_composite(p_user uuid, p_month text)
returns table (
  user_id           uuid,
  month             text,
  performance_score numeric,
  incentives_score  numeric,
  attendance_score  numeric,
  flags_score       numeric,
  composite_score   numeric,
  level             text,
  warning_count     int
)
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_cfg public.performance_config%rowtype;
  v_perf numeric;
  v_inc numeric;
  v_att numeric;
  v_flg numeric;
  v_composite numeric;
  v_warnings int;
begin
  select * into v_cfg from public.performance_config where id = 1;

  -- Performance pillar: normalize 0-10 rating to 0-100
  select round((coalesce(overall_score, 0) * 10)::numeric, 1)
    into v_perf
    from public.performance_ratings
    where user_id = p_user and month = p_month;

  v_inc := public.perf_incentives_score(p_user, p_month);
  v_att := public.perf_attendance_score(p_user, p_month);
  v_flg := public.perf_flags_score(p_user, p_month);

  if v_perf is null then
    v_composite := null;
  else
    v_composite := round((
      v_perf * v_cfg.weight_performance
      + coalesce(v_inc, 0) * v_cfg.weight_incentives
      + coalesce(v_att, 0) * v_cfg.weight_attendance
      + coalesce(v_flg, 0) * v_cfg.weight_flags
    ) / nullif(
      v_cfg.weight_performance + v_cfg.weight_incentives
      + v_cfg.weight_attendance + v_cfg.weight_flags, 0
    ), 1);
  end if;

  select count(*) into v_warnings from public.performance_warnings where user_id = p_user;

  return query select
    p_user,
    p_month,
    v_perf,
    v_inc,
    v_att,
    v_flg,
    v_composite,
    public.perf_level(v_composite),
    v_warnings;
end;
$$;
grant execute on function public.get_performance_composite(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- 4. Team overview RPC (for manager dashboards)
-- Returns one row per active profile visible to the caller, with
-- composite pillars & level for the requested month.
-- ------------------------------------------------------------
create or replace function public.get_performance_overview(p_month text)
returns table (
  user_id           uuid,
  display_name      text,
  role              text,
  avatar_url        text,
  performance_score numeric,
  incentives_score  numeric,
  attendance_score  numeric,
  flags_score       numeric,
  composite_score   numeric,
  level             text,
  green_flags       int,
  red_flags         int,
  warning_count     int
)
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_caller uuid := auth.uid();
  v_is_mgr bool := public.is_boss(v_caller)
                  or exists (select 1 from public.profiles p where p.id = v_caller and p.role in ('ol','developer','tl','pctl') and p.is_active);
  v_start  timestamptz := (p_month || '-01')::timestamptz;
  v_end    timestamptz := ((p_month || '-01')::date + interval '1 month')::timestamptz;
begin
  if v_caller is null or not v_is_mgr then
    return;
  end if;

  return query
  with scope as (
    select p.id, p.display_name, p.role, p.avatar_url
      from public.profiles p
     where p.is_active = true
       and (
         public.is_boss(v_caller)
         or exists (select 1 from public.profiles me where me.id = v_caller and me.role in ('ol','developer'))
         or p.reports_to = v_caller
       )
  ),
  comp as (
    select s.id,
           s.display_name,
           s.role,
           s.avatar_url,
           c.performance_score,
           c.incentives_score,
           c.attendance_score,
           c.flags_score,
           c.composite_score,
           c.level,
           c.warning_count
      from scope s
      cross join lateral public.get_performance_composite(s.id, p_month) c
  )
  select
    c.id,
    c.display_name,
    c.role,
    c.avatar_url,
    c.performance_score,
    c.incentives_score,
    c.attendance_score,
    c.flags_score,
    c.composite_score,
    c.level,
    coalesce((select count(*)::int from public.performance_flags f
              where f.user_id = c.id and f.type = 'green'
                and f.created_at >= v_start and f.created_at < v_end), 0),
    coalesce((select count(*)::int from public.performance_flags f
              where f.user_id = c.id and f.type = 'red'
                and f.created_at >= v_start and f.created_at < v_end), 0),
    c.warning_count
  from comp c
  order by
    (c.composite_score is null),
    c.composite_score desc,
    c.display_name asc;
end;
$$;
grant execute on function public.get_performance_overview(text) to authenticated;

-- ------------------------------------------------------------
-- 5. Boss-only config updater
-- ------------------------------------------------------------
create or replace function public.update_performance_config(
  p_weight_performance  numeric,
  p_weight_incentives   numeric,
  p_weight_attendance   numeric,
  p_weight_flags        numeric,
  p_min_attendance_days int,
  p_threshold_promotion numeric,
  p_threshold_good      numeric,
  p_threshold_warning   numeric,
  p_flag_pts_low        numeric,
  p_flag_pts_medium     numeric,
  p_flag_pts_high       numeric,
  p_flag_pts_critical   numeric
)
returns public.performance_config
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.performance_config;
  v_sum numeric := p_weight_performance + p_weight_incentives
                 + p_weight_attendance + p_weight_flags;
begin
  if not public.is_boss(auth.uid()) then
    raise exception 'only boss can update performance config';
  end if;
  if abs(v_sum - 100) > 0.01 then
    raise exception 'weights must sum to 100 (got %)', v_sum;
  end if;
  if p_threshold_promotion <= p_threshold_good
     or p_threshold_good <= p_threshold_warning
     or p_threshold_warning < 0 then
    raise exception 'thresholds must be promotion > good > warning >= 0';
  end if;

  update public.performance_config set
    weight_performance  = p_weight_performance,
    weight_incentives   = p_weight_incentives,
    weight_attendance   = p_weight_attendance,
    weight_flags        = p_weight_flags,
    min_attendance_days = p_min_attendance_days,
    threshold_promotion = p_threshold_promotion,
    threshold_good      = p_threshold_good,
    threshold_warning   = p_threshold_warning,
    flag_pts_low        = p_flag_pts_low,
    flag_pts_medium     = p_flag_pts_medium,
    flag_pts_high       = p_flag_pts_high,
    flag_pts_critical   = p_flag_pts_critical,
    updated_by          = auth.uid(),
    updated_at          = now()
  where id = 1
  returning * into v_row;
  return v_row;
end;
$$;
grant execute on function public.update_performance_config(
  numeric, numeric, numeric, numeric, int,
  numeric, numeric, numeric,
  numeric, numeric, numeric, numeric
) to authenticated;

-- ------------------------------------------------------------
-- 6. Notifications: rating saved, flag added, warning issued
-- ------------------------------------------------------------
create or replace function public.perf_notify_rating()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_name text;
  v_score numeric := coalesce(new.overall_score, 0);
begin
  if new.evaluated_by is null or new.evaluated_by = new.user_id then
    return new;
  end if;
  v_actor_name := public.profile_display_name(new.evaluated_by);
  perform public.emit_notification(
    new.user_id, new.evaluated_by, 'system', 'performance.rating',
    'Performance rating',
    v_actor_name || ' rated you ' || to_char(v_score, 'FM9D0') || '/10 for ' || new.month,
    'performance', new.id, '/performance'
  );
  return new;
end;
$$;

drop trigger if exists perf_notify_rating on public.performance_ratings;
create trigger perf_notify_rating
  after insert or update on public.performance_ratings
  for each row execute function public.perf_notify_rating();

create or replace function public.perf_notify_flag()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_name text;
  v_title text;
begin
  if new.created_by is null or new.created_by = new.user_id then
    return new;
  end if;
  v_actor_name := public.profile_display_name(new.created_by);
  v_title := case when new.type = 'green' then 'Green flag' else 'Red flag' end;
  perform public.emit_notification(
    new.user_id, new.created_by, 'system', 'performance.flag',
    v_title || ' (' || new.severity || ')',
    v_actor_name || ': ' || left(new.reason, 140),
    'performance', new.id, '/performance'
  );
  return new;
end;
$$;

drop trigger if exists perf_notify_flag on public.performance_flags;
create trigger perf_notify_flag
  after insert on public.performance_flags
  for each row execute function public.perf_notify_flag();

create or replace function public.perf_notify_warning()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_name text;
  v_count int;
begin
  if new.created_by is null or new.created_by = new.user_id then
    return new;
  end if;
  v_actor_name := public.profile_display_name(new.created_by);
  select count(*) into v_count from public.performance_warnings where user_id = new.user_id;
  perform public.emit_notification(
    new.user_id, new.created_by, 'system', 'performance.warning',
    'Formal warning issued' ||
      (case when v_count >= 3 then ' — termination risk' else '' end),
    v_actor_name || ': ' || left(new.reason, 140),
    'performance', new.id, '/performance'
  );
  return new;
end;
$$;

drop trigger if exists perf_notify_warning on public.performance_warnings;
create trigger perf_notify_warning
  after insert on public.performance_warnings
  for each row execute function public.perf_notify_warning();

