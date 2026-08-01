-- ============================================================
-- 286 — Attendance score: an in-progress TODAY must not count against you.
--
-- Bug: the Performance pillar showed "Days not covered: 1" / 96.7% for a user who
-- had clocked in every elapsed day, while the Attendance page (and the Roster,
-- the calendar, the bulk-mark) all showed 0 missed. Root cause: those surfaces
-- read the PAST-ONLY missed set (missed_dates_past, "a day only becomes missable
-- once it has fully elapsed"), but the SCALAR score fields — days_not_covered and
-- pct — were computed with cutoff = TODAY, so an uncovered *today* (a day you can
-- still clock into) was counted as a miss and dragged the score below 100.
--
-- Fix (single source, one place): credit an uncovered TODAY as covered for the
-- score, i.e. today never counts as "not covered" until it has fully elapsed:
--   days_not_covered := past weekdays not covered      (== missed_dates_past length)
--   pct              := (covered + uncovered_today) / elapsed
-- Everything else — covered_days, elapsed_days, all date arrays (incl. the
-- today-inclusive missed_dates), the weekday/holiday/leave logic — is unchanged,
-- so the calendar / roster / present cards are untouched.
--
-- Blast radius is intentional and consistent: perf_attendance_score (the composite
-- attendance pillar), the Attendance page's %/badge, and the incentive-autofill
-- preview all read this pct and now agree at 100% for Hareem's case. Month-end
-- payouts are IDENTICAL: once the month is strictly past there is no "today" in it
-- (uncovered_today = 0), so pct collapses to the original covered/elapsed. The
-- composite-parity harness reads perf_attendance_score on both sides, so it stays
-- in parity. Only the bulk engine changes; the single-user wrapper,
-- perf_attendance_score and incentive_attendance_pct delegate to it untouched.
-- ============================================================
create or replace function public.attendance_month_breakdown_bulk(
  p_month    text,
  p_user_ids uuid[] default null
) returns table (
  user_id             uuid,
  month               text,
  cutoff_date         date,
  elapsed_days        int,
  days_clocked_in     int,
  days_present        int,
  adjusted_days       int,
  days_clocked_in_all int,
  days_present_all    int,
  weekend_days        int,
  holiday_days        int,
  leave_days          int,
  covered_days        int,
  days_not_covered    int,
  pct                 numeric,
  pct_display         int,
  missed_dates        jsonb,
  missed_dates_past   jsonb,
  present_dates       jsonb,
  adjusted_dates      jsonb,
  leave_dates         jsonb,
  holiday_dates       jsonb
)
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_uid      uuid := auth.uid();
  v_svc      boolean := coalesce(
                 nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', ''
               ) = 'service_role'
               or session_user in ('postgres', 'supabase_admin');
  v_priv     boolean;
  v_start    date;
  v_end      date;
  v_today    date := (now() at time zone 'Asia/Karachi')::date;
  v_cutoff   date;
  v_elapsed  int;
  v_weekends int;
  v_holidays int;
begin
  if v_uid is null and not v_svc then return; end if;
  if p_month is null or p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then return; end if;

  v_priv := v_svc
    or public.is_boss(v_uid)
    or exists (
      select 1 from public.profiles p
       where p.id = v_uid
         and p.role in ('ol', 'developer')
         and p.is_active = true
         and p.deleted_at is null
    );

  v_start  := to_date(p_month || '-01', 'YYYY-MM-DD');
  v_end    := (v_start + interval '1 month' - interval '1 day')::date;
  v_cutoff := least(v_today, v_end);

  v_elapsed := greatest(0, (v_cutoff - v_start) + 1);

  select count(*)::int into v_weekends
    from generate_series(v_start, v_cutoff, interval '1 day') g
   where extract(isodow from g) in (6, 7);

  select count(*)::int into v_holidays
    from generate_series(v_start, v_cutoff, interval '1 day') g
   where extract(isodow from g) between 1 and 5
     and exists (
       select 1 from public.company_holidays h
        where g::date between h.start_date and h.end_date
     );

  return query
  with targets as (
    select p.id
      from public.profiles p
     where (p_user_ids is null or p.id = any(p_user_ids))
       and (v_priv or p.id = v_uid or p.reports_to = v_uid)
  ),
  cal as (
    select g::date as d from generate_series(v_start, v_cutoff, interval '1 day') g
  ),
  cal_full as (
    select g::date as d from generate_series(v_start, v_end, interval '1 day') g
  ),
  wk as (
    select c.d from cal c where extract(isodow from c.d) in (6, 7)
  ),
  hol_full as (
    select distinct c.d
      from cal_full c
      join public.company_holidays h on c.d between h.start_date and h.end_date
     where extract(isodow from c.d) between 1 and 5
  ),
  hol as (
    select h.d from hol_full h where h.d <= v_cutoff
  ),
  pres_full as (
    select distinct a.user_id as uid, a.date as d
      from public.attendance a
      join targets t on t.id = a.user_id
     where a.clock_in is not null
       and a.date between v_start and v_end
  ),
  adj_full as (
    select distinct aa.user_id as uid, aa.date as d
      from public.attendance_adjustments aa
      join targets t on t.id = aa.user_id
     where aa.date between v_start and v_end
  ),
  leave_full as (
    select distinct lr.requester_id as uid, gs.g::date as d
      from public.leave_requests lr
      join targets t on t.id = lr.requester_id
      cross join lateral generate_series(
        greatest(lr.start_date, v_start),
        least(lr.end_date, v_end),
        interval '1 day'
      ) as gs(g)
     where lr.status = 'approved'
       and lr.type in ('medical', 'emergency', 'half_leave', 'other')
       and lr.start_date <= v_end
       and lr.end_date   >= v_start
       and extract(isodow from gs.g) between 1 and 5
       and not exists (select 1 from hol_full h where h.d = gs.g::date)
  ),
  covered as (
        select t.id as uid, w.d from targets t cross join wk  w
    union
        select t.id as uid, h.d from targets t cross join hol h
    union
        select l.uid, l.d from leave_full l where l.d <= v_cutoff
    union
        select p.uid, p.d from pres_full  p where p.d <= v_cutoff
    union
        select a.uid, a.d from adj_full   a where a.d <= v_cutoff
  ),
  missed as (
    select t.id as uid, c.d
      from targets t
      cross join cal c
     where not exists (
       select 1 from covered cv where cv.uid = t.id and cv.d = c.d
     )
  ),
  agg as (
    select
      t.id as uid,
      (select count(*)::int from pres_full p
        where p.uid = t.id and p.d <= v_cutoff
          and extract(isodow from p.d) between 1 and 5)                 as ci_wd,
      (select count(*)::int from (
          select p.d from pres_full p where p.uid = t.id and p.d <= v_cutoff
          union
          select a.d from adj_full  a where a.uid = t.id and a.d <= v_cutoff
        ) x where extract(isodow from x.d) between 1 and 5)             as pres_wd,
      (select count(*)::int from pres_full p
        where p.uid = t.id and p.d <= v_cutoff)                         as ci_all,
      (select count(*)::int from (
          select p.d from pres_full p where p.uid = t.id and p.d <= v_cutoff
          union
          select a.d from adj_full  a where a.uid = t.id and a.d <= v_cutoff
        ) x)                                                            as pres_all,
      (select count(*)::int from leave_full l
        where l.uid = t.id and l.d <= v_cutoff)                         as lv,
      (select count(*)::int from covered cv where cv.uid = t.id)        as cov,
      -- uncovered_today: 0/1 — an uncovered TODAY (still clockable). Credited as
      -- covered for the score so it never drags the pct until it fully elapses.
      (select count(*)::int from missed m
        where m.uid = t.id and m.d = v_today)                          as ut,
      -- days_not_covered scalar = PAST weekdays not covered (today exempt).
      (select count(*)::int from missed m
        where m.uid = t.id and m.d < v_today)                          as mp,
      (select coalesce(jsonb_agg(to_char(m.d, 'YYYY-MM-DD') order by m.d), '[]'::jsonb)
         from missed m where m.uid = t.id)                              as j_missed,
      (select coalesce(jsonb_agg(to_char(m.d, 'YYYY-MM-DD') order by m.d), '[]'::jsonb)
         from missed m where m.uid = t.id and m.d < v_today)            as j_missed_past,
      (select coalesce(jsonb_agg(to_char(p.d, 'YYYY-MM-DD') order by p.d), '[]'::jsonb)
         from pres_full p where p.uid = t.id)                           as j_present,
      (select coalesce(jsonb_agg(to_char(a.d, 'YYYY-MM-DD') order by a.d), '[]'::jsonb)
         from adj_full a where a.uid = t.id)                            as j_adjusted,
      (select coalesce(jsonb_agg(to_char(l.d, 'YYYY-MM-DD') order by l.d), '[]'::jsonb)
         from leave_full l where l.uid = t.id)                          as j_leave,
      (select coalesce(jsonb_agg(to_char(h.d, 'YYYY-MM-DD') order by h.d), '[]'::jsonb)
         from hol_full h)                                               as j_holiday
    from targets t
  )
  select
    g.uid,
    p_month,
    case when v_cutoff >= v_start then v_cutoff else null end,
    v_elapsed,
    g.ci_wd,
    g.pres_wd,
    g.pres_wd - g.ci_wd,
    g.ci_all,
    g.pres_all,
    v_weekends,
    v_holidays,
    g.lv,
    g.cov,
    -- Today exempt: only PAST uncovered weekdays count as "not covered".
    g.mp,
    -- Credit an uncovered today (g.ut) into the numerator so a still-clockable
    -- day never pulls the score below 100. Denominator stays elapsed; once the
    -- month is strictly past, g.ut is 0 and this is exactly covered/elapsed.
    case when v_elapsed > 0
         then least(100::numeric, round(((g.cov + g.ut)::numeric / v_elapsed::numeric) * 100, 1))
         end,
    case when v_elapsed > 0
         then least(100, round(((g.cov + g.ut)::numeric / v_elapsed::numeric) * 100))::int
         end,
    g.j_missed,
    g.j_missed_past,
    g.j_present,
    g.j_adjusted,
    g.j_leave,
    g.j_holiday
  from agg g;
end;
$$;

revoke execute on function public.attendance_month_breakdown_bulk(text, uuid[]) from public;
revoke execute on function public.attendance_month_breakdown_bulk(text, uuid[]) from anon;
grant  execute on function public.attendance_month_breakdown_bulk(text, uuid[]) to authenticated, service_role;
