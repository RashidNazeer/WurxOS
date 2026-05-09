-- ============================================================
-- Migration 056 — Attendance × Leave integration
--
-- v1 rule: approved leave should NOT count against your
-- attendance performance score. We update perf_attendance_score
-- so that approved leave days count as "present" (a half_leave
-- request counts as 0.5 days, other full-day leave as 1).
--
-- Also adds an "on_leave_dates_month" helper used by UI to render
-- leave days in the attendance history.
-- ============================================================

create or replace function public.on_leave_dates_month(
  p_user uuid, p_year int, p_month int
)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  with bounds as (
    select make_date(p_year, p_month, 1)                    as m_start,
           (make_date(p_year, p_month, 1) + interval '1 month - 1 day')::date as m_end
  ),
  approved as (
    select lr.type, lr.start_date, lr.end_date
      from public.leave_requests lr, bounds b
     where lr.requester_id = p_user
       and lr.status = 'approved'
       and lr.start_date <= b.m_end
       and lr.end_date   >= b.m_start
  ),
  expanded as (
    select a.type,
           generate_series(
             greatest(a.start_date, b.m_start),
             least(a.end_date, b.m_end),
             interval '1 day'
           )::date as d
      from approved a, bounds b
  )
  select coalesce(jsonb_agg(jsonb_build_object('date', d, 'type', type) order by d), '[]'::jsonb)
    from expanded;
$$;
grant execute on function public.on_leave_dates_month(uuid, int, int) to authenticated;

-- --------------------------------------------------------------
-- Attendance pillar — counts approved leave as present.
-- half_leave counts as 0.5; any other approved leave as 1.
-- --------------------------------------------------------------
create or replace function public.perf_attendance_score(p_user uuid, p_month text)
returns numeric
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_min       int;
  v_present   numeric;
  v_leave     numeric;
  v_start     date := (p_month || '-01')::date;
  v_end       date := (p_month || '-01')::date + interval '1 month';
begin
  select min_attendance_days into v_min from public.performance_config where id = 1;
  if v_min is null or v_min = 0 then v_min := 22; end if;

  -- Days where the user has an attendance row at all (present OR auto-closed)
  select count(distinct date)::numeric into v_present
    from public.attendance
   where user_id = p_user
     and date >= v_start and date < v_end;

  -- Days covered by approved leave requests in the same window.
  -- half_leave = 0.5; full-day leave = 1. Days already counted in
  -- attendance are NOT subtracted (e.g. user on emergency leave but
  -- clocked in for an hour → still counts as 1, not 1.5).
  with approved as (
    select lr.type, lr.start_date, lr.end_date
      from public.leave_requests lr
     where lr.requester_id = p_user
       and lr.status = 'approved'
       and lr.start_date < v_end
       and lr.end_date   >= v_start
  ),
  days as (
    select generate_series(
             greatest(a.start_date, v_start),
             least(a.end_date, v_end - 1),
             interval '1 day'
           )::date as d,
           a.type as t
      from approved a
  )
  select coalesce(sum(
    case when t = 'half_leave' then 0.5 else 1 end
  ), 0) into v_leave
    from days
   where d not in (
     select distinct date from public.attendance
      where user_id = p_user and date >= v_start and date < v_end
   );

  return least(100, round(((v_present + v_leave) / v_min::numeric) * 100, 1));
end;
$$;
grant execute on function public.perf_attendance_score(uuid, text) to authenticated;
