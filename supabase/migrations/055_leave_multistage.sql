-- ============================================================
-- Migration 055 — Leave multi-stage approval, paid/unpaid,
-- new categories (half_leave, other), and Boss paid-override.
--
-- Adds to leave_requests:
--   current_level   int  — 1..3, which rung of the reports_to ladder
--                          is the current approver
--   decisions       jsonb — audit trail, one entry per stage action
--   paid_days       numeric — computed at submit from quota vs consumption
--   unpaid_days     numeric — requested minus paid
--   paid_override   boolean — Boss can flip unpaid → paid retroactively
--   other_title     text    — custom reason label when type = 'other'
--
-- Type vocabulary expands from {wfh,medical,emergency} to also
-- include 'half_leave' (0.5d against medical quota) and 'other'
-- (no quota consumed).
--
-- Replaces single-approver model with ladder-based multi-stage:
--   level 1 = requester's direct reports_to
--   level 2 = their reports_to
--   level 3 = Boss fallback
-- leave_decide(id, action, note) is the single entry point for
-- approvers. "forward" bumps the level without deciding.
--
-- consumed_leaves_month(uid, year, month) gives the quota math the
-- UI needs (v1 quotas are per-calendar-month, not per-year).
-- ============================================================

-- --------------------------------------------------------------
-- 1. Expand schema
-- --------------------------------------------------------------
alter table public.leave_requests
  drop constraint if exists leave_requests_type_check;
alter table public.leave_requests
  add constraint leave_requests_type_check
    check (type in ('wfh','medical','emergency','half_leave','other'));

alter table public.leave_requests
  add column if not exists current_level int not null default 1
    check (current_level between 1 and 3);
alter table public.leave_requests
  add column if not exists decisions jsonb not null default '[]'::jsonb;
alter table public.leave_requests
  add column if not exists paid_days numeric(5,2) not null default 0;
alter table public.leave_requests
  add column if not exists unpaid_days numeric(5,2) not null default 0;
alter table public.leave_requests
  add column if not exists paid_override boolean not null default false;
alter table public.leave_requests
  add column if not exists other_title text;

create index if not exists leave_requests_pending_level_idx
  on public.leave_requests(status, current_level)
  where status = 'pending';

-- --------------------------------------------------------------
-- 2. Current-approver helper — walks reports_to N times from the
--    requester. Falls back to the first active Boss at any step
--    where reports_to is null (e.g., requester is OL and level=1
--    gives Boss directly).
-- --------------------------------------------------------------
create or replace function public.leave_current_approver(p_request_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_req       record;
  v_cur       uuid;
  v_i         int;
  v_boss      uuid;
begin
  select requester_id, current_level, status
    into v_req
    from public.leave_requests
    where id = p_request_id;

  if not found or v_req.status <> 'pending' then return null; end if;

  select id into v_boss from public.profiles
   where role = 'boss' and is_active = true
   order by created_at asc limit 1;

  v_cur := v_req.requester_id;
  for v_i in 1..v_req.current_level loop
    select reports_to into v_cur from public.profiles where id = v_cur;
    if v_cur is null then
      return v_boss;  -- chain ended early, Boss is the final arbiter
    end if;
  end loop;

  -- If we climbed the full ladder and the person is the same as the
  -- requester (possible on Boss self-requests), return Boss itself.
  if v_cur = v_req.requester_id then return v_boss; end if;
  return v_cur;
end;
$$;
grant execute on function public.leave_current_approver(uuid) to authenticated;

-- --------------------------------------------------------------
-- 3. Per-month quota consumption
--    Half-leave counts as 0.5 days against medical.
--    "other" does NOT consume any quota (it's just a record).
--    "wfh" consumes the wfh quota normally.
--    Results: { wfh, medical, emergency } per month.
-- --------------------------------------------------------------
create or replace function public.consumed_leaves_month(
  p_user uuid, p_year int, p_month int
)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  with rows_in_month as (
    select type,
           (end_date - start_date + 1)::numeric as raw_days
      from public.leave_requests
     where requester_id = p_user
       and status = 'approved'
       and extract(year  from start_date) = p_year
       and extract(month from start_date) = p_month
  ),
  tallied as (
    select case when type = 'half_leave' then 'medical' else type end as bucket,
           case when type = 'half_leave' then 0.5 else raw_days end as days
      from rows_in_month
  )
  select jsonb_build_object(
    'wfh',       coalesce((select sum(days)::numeric from tallied where bucket = 'wfh'), 0),
    'medical',   coalesce((select sum(days)::numeric from tallied where bucket = 'medical'), 0),
    'emergency', coalesce((select sum(days)::numeric from tallied where bucket = 'emergency'), 0)
  );
$$;
grant execute on function public.consumed_leaves_month(uuid, int, int) to authenticated;

-- Also fix the original consumed_leaves to count half_leave correctly
-- (0.5 days against medical) so older callers stay sane.
create or replace function public.consumed_leaves(p_user uuid, p_year int)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  with rows_in_year as (
    select type,
           (end_date - start_date + 1)::numeric as raw_days
      from public.leave_requests
     where requester_id = p_user
       and status = 'approved'
       and extract(year from start_date) = p_year
  ),
  tallied as (
    select case when type = 'half_leave' then 'medical' else type end as bucket,
           case when type = 'half_leave' then 0.5 else raw_days end as days
      from rows_in_year
  )
  select jsonb_build_object(
    'wfh',       coalesce((select sum(days)::numeric from tallied where bucket = 'wfh'),       0),
    'medical',   coalesce((select sum(days)::numeric from tallied where bucket = 'medical'),   0),
    'emergency', coalesce((select sum(days)::numeric from tallied where bucket = 'emergency'), 0)
  );
$$;
grant execute on function public.consumed_leaves(uuid, int) to authenticated;

-- --------------------------------------------------------------
-- 4. Compute paid/unpaid on submission via BEFORE INSERT trigger
--    Quota is monthly; "other" consumes no quota; half_leave is 0.5d.
--    If the requested days exceed remaining monthly quota, split
--    into paid (remaining) + unpaid (excess).
-- --------------------------------------------------------------
create or replace function public.leave_compute_paid_days()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quota      jsonb;
  v_consumed   jsonb;
  v_bucket     text;
  v_quota_d    numeric;
  v_used_d     numeric;
  v_remaining  numeric;
  v_requested  numeric;
  v_month      int;
  v_year       int;
begin
  -- Other: always unpaid, zero quota consumed
  if new.type = 'other' then
    new.paid_days   := 0;
    new.unpaid_days := (new.end_date - new.start_date + 1)::numeric;
    return new;
  end if;

  -- Requested days count
  if new.type = 'half_leave' then
    v_requested := 0.5;
  else
    v_requested := (new.end_date - new.start_date + 1)::numeric;
  end if;

  -- Which quota bucket does this type count against?
  v_bucket := case new.type
    when 'half_leave' then 'medical'
    when 'medical'    then 'medical'
    when 'emergency'  then 'emergency'
    when 'wfh'        then 'wfh'
    else null
  end;

  -- Pull quota + consumption
  select coalesce(leave_quota, '{}'::jsonb) into v_quota
    from public.profiles where id = new.requester_id;
  v_quota_d := coalesce((v_quota->>v_bucket)::numeric, 0);

  v_year  := extract(year  from new.start_date)::int;
  v_month := extract(month from new.start_date)::int;
  v_consumed := public.consumed_leaves_month(new.requester_id, v_year, v_month);
  v_used_d := coalesce((v_consumed->>v_bucket)::numeric, 0);

  v_remaining := greatest(0, v_quota_d - v_used_d);

  if v_requested <= v_remaining then
    new.paid_days   := v_requested;
    new.unpaid_days := 0;
  else
    new.paid_days   := v_remaining;
    new.unpaid_days := v_requested - v_remaining;
  end if;

  return new;
end;
$$;

drop trigger if exists leave_compute_paid_bi on public.leave_requests;
create trigger leave_compute_paid_bi
  before insert on public.leave_requests
  for each row execute function public.leave_compute_paid_days();

-- --------------------------------------------------------------
-- 5. Multi-stage decide RPC — approve / reject / forward.
--    Boss can always act; otherwise only the current-level
--    approver can decide.
-- --------------------------------------------------------------
create or replace function public.leave_decide(
  p_request_id uuid,
  p_action     text,  -- 'approve' | 'reject' | 'forward'
  p_note       text default null
)
returns public.leave_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req        public.leave_requests;
  v_me         uuid := auth.uid();
  v_approver   uuid;
  v_name       text;
  v_decisions  jsonb;
  v_new_level  int;
begin
  if v_me is null then raise exception 'not authenticated'; end if;

  select * into v_req from public.leave_requests where id = p_request_id for update;
  if not found                  then raise exception 'request not found'; end if;
  if v_req.status <> 'pending'  then raise exception 'request already decided (status=%)', v_req.status; end if;

  v_approver := public.leave_current_approver(p_request_id);
  if v_approver <> v_me and not public.is_boss(v_me) then
    raise exception 'not authorized to decide this request';
  end if;

  v_name := coalesce(public.profile_display_name(v_me), 'Someone');
  v_decisions := v_req.decisions || jsonb_build_array(jsonb_build_object(
    'level',   v_req.current_level,
    'action',  p_action,
    'by',      v_me,
    'by_name', v_name,
    'at',      to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'note',    p_note
  ));

  if p_action = 'approve' then
    update public.leave_requests
       set status        = 'approved',
           decided_by    = v_me,
           decided_at    = now(),
           decision_note = p_note,
           decisions     = v_decisions
     where id = p_request_id
     returning * into v_req;

  elsif p_action = 'reject' then
    update public.leave_requests
       set status        = 'rejected',
           decided_by    = v_me,
           decided_at    = now(),
           decision_note = p_note,
           decisions     = v_decisions
     where id = p_request_id
     returning * into v_req;

  elsif p_action = 'forward' then
    v_new_level := v_req.current_level + 1;
    if v_new_level > 3 then raise exception 'already at top of approval chain'; end if;
    update public.leave_requests
       set current_level = v_new_level,
           decisions     = v_decisions
     where id = p_request_id
     returning * into v_req;

  else
    raise exception 'invalid action: %', p_action;
  end if;

  return v_req;
end;
$$;
grant execute on function public.leave_decide(uuid, text, text) to authenticated;

-- --------------------------------------------------------------
-- 6. Boss paid-override — retroactively mark unpaid days as paid
--    without changing quota consumption. Audit trail captured.
-- --------------------------------------------------------------
create or replace function public.leave_set_paid_override(
  p_request_id uuid, p_override boolean, p_note text default null
)
returns public.leave_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req public.leave_requests;
  v_me  uuid := auth.uid();
begin
  if not public.is_boss(v_me) then
    raise exception 'only Boss can override paid status';
  end if;
  update public.leave_requests
     set paid_override = p_override,
         decisions     = decisions || jsonb_build_array(jsonb_build_object(
                           'level',   99,  -- sentinel: post-decision
                           'action',  case when p_override then 'paid-override-on' else 'paid-override-off' end,
                           'by',      v_me,
                           'by_name', coalesce(public.profile_display_name(v_me), 'Boss'),
                           'at',      to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                           'note',    p_note
                         ))
   where id = p_request_id
   returning * into v_req;
  return v_req;
end;
$$;
grant execute on function public.leave_set_paid_override(uuid, boolean, text) to authenticated;

-- --------------------------------------------------------------
-- 7. RLS — extend update policy to allow the current-level
--    approver (not just a static reports_to), while keeping Boss
--    and requester-own-pending rules.
-- --------------------------------------------------------------
drop policy if exists "leave_update" on public.leave_requests;
create policy "leave_update"
  on public.leave_requests for update
  using (
    (auth.uid() = requester_id and status = 'pending')
    or auth.uid() = public.leave_current_approver(id)
    or public.is_boss(auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role in ('developer') and p.is_active = true
    )
  )
  with check (
    (auth.uid() = requester_id and status in ('pending','cancelled'))
    or auth.uid() = public.leave_current_approver(id)
    or public.is_boss(auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role in ('developer') and p.is_active = true
    )
  );

-- SELECT policy — make sure the current approver can always read
-- their pending queue even if reports_to differs from the ladder.
drop policy if exists "leave_select" on public.leave_requests;
create policy "leave_select"
  on public.leave_requests for select
  using (
    auth.uid() = requester_id
    or auth.uid() = public.leave_current_approver(id)
    or auth.uid() = public.leave_approver(requester_id)   -- legacy compat
    or public.is_boss(auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true
    )
  );

-- --------------------------------------------------------------
-- 8. Helper — is_on_leave(uid, date) for attendance integration
--    Returns true if the user has an approved leave that covers
--    the given date. Used by attendance UI to skip "absent" days.
-- --------------------------------------------------------------
create or replace function public.is_on_leave(p_user uuid, p_date date)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.leave_requests
     where requester_id = p_user
       and status = 'approved'
       and start_date <= p_date
       and end_date   >= p_date
       and type in ('medical','emergency','half_leave','wfh','other')
  );
$$;
grant execute on function public.is_on_leave(uuid, date) to authenticated;

-- --------------------------------------------------------------
-- 9. Update the submit-notification trigger to target the
--    current-level approver (not the static reports_to approver).
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
  v_label    text;
begin
  v_approver := public.leave_current_approver(new.id);
  if v_approver is null or v_approver = new.requester_id then return new; end if;

  v_name  := public.profile_display_name(new.requester_id);
  v_label := case new.type
    when 'wfh'        then 'WFH'
    when 'medical'    then 'medical leave'
    when 'emergency'  then 'emergency leave'
    when 'half_leave' then 'half-day leave'
    when 'other'      then coalesce(new.other_title, 'time off')
    else new.type
  end;

  perform public.emit_notification(
    v_approver, new.requester_id, 'leave', 'leave.requested',
    'New leave request',
    v_name || ' requested ' || v_label || ' ('
      || to_char(new.start_date, 'Mon DD')
      || case when new.end_date <> new.start_date then ' – ' || to_char(new.end_date, 'Mon DD') else '' end
      || ')',
    'leave', new.id, '/leave/approvals'
  );
  return new;
end;
$$;

-- On FORWARD the current_level changes but status stays 'pending'.
-- Notify the NEW level's approver. Fires on every update that
-- actually moves current_level.
create or replace function public.leave_notify_on_forward()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_approver uuid;
  v_name     text;
begin
  if old.current_level is distinct from new.current_level
     and new.status = 'pending' then
    v_approver := public.leave_current_approver(new.id);
    if v_approver is not null and v_approver <> new.requester_id then
      v_name := public.profile_display_name(new.requester_id);
      perform public.emit_notification(
        v_approver, new.requester_id, 'leave', 'leave.forwarded',
        'Leave request forwarded to you',
        v_name || '''s leave request was escalated for your decision.',
        'leave', new.id, '/leave/approvals'
      );
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists leave_notify_forward_au on public.leave_requests;
create trigger leave_notify_forward_au
  after update of current_level on public.leave_requests
  for each row execute function public.leave_notify_on_forward();
