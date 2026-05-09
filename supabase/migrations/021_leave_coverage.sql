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
