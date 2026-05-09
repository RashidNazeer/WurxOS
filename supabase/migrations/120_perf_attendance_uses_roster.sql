-- ============================================================
-- Migration 120 — Performance attendance score = Roster math
--
-- Two fixes, both about keeping the Roster tab and the Performance
-- attendance pillar in lockstep:
--
--   1. WFH leaves don't count as leaves for attendance coverage —
--      the user clocks in from home, so a WFH day is naturally a
--      Present day. Without this filter, a WFH-without-clock-in
--      inflated coverage. Affects:
--        - att_adjust_bulk_mark_missed (its missed-day computation)
--        - perf_attendance_score        (the pillar formula)
--
--   2. perf_attendance_score now folds in attendance_adjustments
--      (Roster manual marks) so a manager-backfilled day counts
--      toward the score, exactly like it counts in the Roster card.
--      Coverage = |present ∪ adjusted ∪ non-WFH leave|, capped at
--      the working-days denominator.
--
-- Net: every UI that reports attendance coverage agrees on the
-- same number for the same (user, month).
-- ============================================================

-- ── 1. att_adjust_bulk_mark_missed: filter WFH out of leaves ──
create or replace function public.att_adjust_bulk_mark_missed(
  p_month    text,
  p_user_ids uuid[],
  p_note     text default null
) returns table (users_touched int, days_added int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id   uuid := auth.uid();
  v_actor_role text;
  v_actor_name text;
  v_month_start date;
  v_month_end   date;
  v_today       date := (now() at time zone 'Asia/Karachi')::date;
  v_uid         uuid;
  v_target_role text;
  v_user_added  int;
  v_total_added int := 0;
  v_users       int := 0;
  v_note        text := nullif(trim(coalesce(p_note,'')), '');
begin
  if v_actor_id is null then raise exception 'not authenticated'; end if;
  select role, display_name into v_actor_role, v_actor_name
    from public.profiles where id = v_actor_id;
  if v_actor_role not in ('boss','ol','developer') then
    raise exception 'only Boss / OL / Developer can bulk-mark';
  end if;
  if p_month !~ '^\d{4}-\d{2}$' then
    raise exception 'month must be YYYY-MM';
  end if;

  v_month_start := to_date(p_month || '-01', 'YYYY-MM-DD');
  v_month_end   := (v_month_start + interval '1 month' - interval '1 day')::date;

  foreach v_uid in array coalesce(p_user_ids, '{}'::uuid[]) loop
    select role into v_target_role from public.profiles where id = v_uid;
    if v_target_role is null then continue; end if;
    if not public._adjust_can_act(v_actor_id, v_actor_role, v_uid, v_target_role) then
      continue;
    end if;

    with weekdays as (
      select d::date as date
      from generate_series(v_month_start, least(v_month_end, v_today), interval '1 day') as d
      where extract(dow from d) not in (0, 6)
    ),
    present as (
      select date::date as date
      from public.attendance
      where user_id = v_uid and clock_in is not null
        and date between v_month_start and v_month_end
    ),
    adjusted as (
      select date from public.attendance_adjustments
      where user_id = v_uid
        and date between v_month_start and v_month_end
    ),
    leaves as (
      -- Only medical / emergency. WFH stays out — those days are
      -- attended via clock-in from home, not a leave.
      select gs.d::date as date
      from public.leave_requests lr
      cross join lateral generate_series(
        greatest(lr.start_date, v_month_start),
        least(lr.end_date, v_month_end),
        interval '1 day'
      ) as gs(d)
      where lr.requester_id = v_uid
        and lr.status = 'approved'
        and lr.type in ('medical','emergency')
        and lr.start_date <= v_month_end
        and lr.end_date   >= v_month_start
    ),
    missed as (
      select w.date from weekdays w
      where not exists (select 1 from present  p where p.date = w.date)
        and not exists (select 1 from adjusted a where a.date = w.date)
        and not exists (select 1 from leaves   l where l.date = w.date)
    ),
    inserted as (
      insert into public.attendance_adjustments (
        user_id, date, note, bulk, created_by, created_by_role
      )
      select v_uid, m.date, v_note, true, v_actor_id, v_actor_role from missed m
      on conflict (user_id, date) do nothing
      returning 1
    )
    select count(*)::int into v_user_added from inserted;

    if v_user_added > 0 then
      v_users := v_users + 1;
      v_total_added := v_total_added + v_user_added;
      perform public.emit_notification(
        v_uid,
        v_actor_id,
        'attendance',
        'attendance.manual_adjustment_bulk',
        coalesce(v_actor_name, 'Your manager') ||
          ' marked ' || v_user_added || ' day' ||
          case when v_user_added = 1 then '' else 's' end ||
          ' present in ' || p_month,
        case when v_note is not null then 'Note: ' || v_note
             else 'Your attendance was backfilled by your manager.' end,
        'attendance_adjustment_bulk',
        null,
        '/attendance'
      );
    end if;
  end loop;

  users_touched := v_users;
  days_added    := v_total_added;
  return next;
end;
$$;
grant execute on function public.att_adjust_bulk_mark_missed(text, uuid[], text) to authenticated;

-- ── 2. perf_attendance_score: union present ∪ adjusted ∪ non-WFH leave ──
-- Coverage is (count of distinct dates) / min_attendance_days, capped at 100.
-- We deliberately use min_attendance_days (a config knob, default 22) as
-- the denominator rather than working-days-of-month so that a short month
-- doesn't artificially boost everyone's score. Roster card percentages do
-- compute against monthly working days for in-month visibility — they're
-- a different consumer. The score here is a fair monthly comparison.
create or replace function public.perf_attendance_score(p_user uuid, p_month text)
returns numeric
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_min     int;
  v_covered numeric;
  v_start   date := (p_month || '-01')::date;
  v_end     date := (p_month || '-01')::date + interval '1 month';
begin
  select min_attendance_days into v_min from public.performance_config where id = 1;
  if v_min is null or v_min = 0 then v_min := 22; end if;

  with present as (
    select distinct date from public.attendance
     where user_id = p_user
       and clock_in is not null
       and date >= v_start and date < v_end
  ),
  adjusted as (
    select distinct date from public.attendance_adjustments
     where user_id = p_user
       and date >= v_start and date < v_end
  ),
  leaves as (
    -- Expand approved medical/emergency leave ranges into dates inside
    -- the month. WFH excluded — those days come in via `present` when
    -- the user clocks in from home.
    select gs.d::date as date
      from public.leave_requests lr
      cross join lateral generate_series(
        greatest(lr.start_date, v_start),
        least(lr.end_date, (v_end - 1)::date),
        interval '1 day'
      ) as gs(d)
     where lr.requester_id = p_user
       and lr.status = 'approved'
       and lr.type in ('medical','emergency')
       and lr.start_date <  v_end
       and lr.end_date   >= v_start
  ),
  covered as (
    select date from present
    union
    select date from adjusted
    union
    select date from leaves
  )
  select count(*)::numeric into v_covered from covered;

  return least(100, round((v_covered / v_min::numeric) * 100, 1));
end;
$$;
grant execute on function public.perf_attendance_score(uuid, text) to authenticated;
