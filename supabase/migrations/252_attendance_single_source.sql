-- ============================================================
-- WurxOS v2 — Migration 252: attendance % = ONE source of truth (SQL)
--
-- WHY
-- ---
-- Attendance coverage was computed THREE different ways that disagreed:
--
--   1. components/performance/PerformancePage.jsx (local JS helpers)
--   2. src/lib/attendanceApi.js  (summarizeMonth / computeMonthlyDays)
--   3. public.perf_attendance_score  (SQL, mig 120)
--
-- The screens (1 + 2) agreed with each other. The SQL (3) did not — and the
-- SQL is the ONLY thing the money reads: incentive_attendance_pct (mig 235)
-- auto-fills an incentive item's Achieved value from perf_attendance_score.
-- So every surface the Boss looks at said one number while the incentive paid
-- on another. For Ali Waseem, 2026-07: screens 93%, incentive 45.5%.
--
-- Three concrete divergences in mig 120, each of them money:
--
--   a. HARDCODED /22. mig 120 divides covered days by
--      performance_config.min_attendance_days (default 22). Real months have
--      20-23 weekdays. Feb (20 wd) => a PERFECT month auto-fills as 90.9% and
--      UNDERPAYS. Jul/Dec (23 wd) => a missed day is INVISIBLE (23-1 = 22 =>
--      still 100%) and OVERPAYS. It also ignores the actual days elapsed, so
--      mid-month it is meaningless.
--
--   b. LEAVE TYPES. mig 120 credits only medical + emergency. The UI (and the
--      leave module) credit medical, emergency, half_leave and 'other' — never
--      wfh (a WFH day is attended via a clock-in from home). So an approved
--      half-day or an approved 'other' leave counted as an ABSENCE in the
--      incentive. Live data: half_leave appears in 2026-06 and 2026-07 today.
--
--   c. COMPANY HOLIDAYS. perf_attendance_score is mig 120; company_holidays is
--      mig 167. The function predates the table and has NEVER credited a
--      holiday. Latent (one Eid row exists: 2026-05-26..28) — it detonates on
--      the next one, charging every employee 3 absences for a company holiday.
--
-- THE FIX
-- -------
-- SQL becomes the single source of truth and the JS formulas are deleted.
-- ONE engine — attendance_month_breakdown_bulk — returns both the SCORE and the
-- BREAKDOWN the Roster / Performance panels render, so nothing on screen loses
-- a number.
--
--   cutoff  = least(karachi_today, month_end)   <- the key line
--   elapsed = CALENDAR days month_start..cutoff
--   covered = weekends
--           ∪ company holidays (weekday-only)
--           ∪ approved leave (medical, emergency, half_leave, other — NOT wfh)
--           ∪ dates with a clock-in
--           ∪ manager adjustments
--   pct     = least(100, covered / elapsed * 100)
--
-- least(today, month_end) is why one formula serves both jobs: mid-month it
-- reads "how much is covered so far"; once the month is over elapsed = the
-- whole month, so the incentive fill on the 1st of the next month gets the
-- final figure automatically with no second code path.
--
-- covered is a SET UNION, never a sum. Ali Waseem 2026-07-01 is literally BOTH
-- a clock-in and an approved leave day; summing the buckets gives 15/15 and the
-- least(100,…) clamp would HIDE his real absence and overpay him.
--
-- PARITY: scripts/attendance-parity.mjs proves the new number reproduces the
-- live UI number exactly (93% for Ali Waseem, 2026-07) for every active
-- employee across every month tested. The only thing that changes is the
-- incentive auto-fill — the thing that was wrong.
--
-- Also in here:
--   * incentive_attendance_pct de-N+1'd (it called perf_attendance_score once
--     per profile — 33 invocations of the whole engine per /incentives load).
--   * att_adjust_bulk_mark_missed now takes its missed days from the SAME
--     breakdown, so it can no longer stamp an adjustment on Eid or on an
--     approved half-leave day, and the preview count can no longer disagree
--     with what actually gets inserted.
--   * The new attendance functions revoke PUBLIC/anon EXECUTE and grant only
--     authenticated + service_role (Postgres grants EXECUTE to PUBLIC by
--     default, so a bare `grant to authenticated` is never itself a gate).
--
-- NOT in here (intentionally split out — this migration is ONLY the formula):
--   * The OL-can-read-attendance RLS widening and the anon-leak revoke on the
--     pre-existing get_performance_composite / get_performance_overview RPCs
--     live in mig 253 (attendance_ol_read_and_perf_revoke). The attendance
--     numbers do NOT depend on either, so they ship as a separate, reviewable
--     permissions change.
--
-- All date boundaries are Asia/Karachi. The cluster runs UTC, so a bare
-- current_date / now()::date is YESTERDAY between 00:00-05:00 PKT (Ali would
-- read 15/15 = 100%). Never current_date in this file.
--
-- performance_config.min_attendance_days is NOT dropped — update_performance_config
-- still takes it as a required positional param and the live weights modal
-- still writes it. It simply stops being READ by any score.
--
-- Idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- 1. THE ENGINE — attendance_month_breakdown_bulk
--
-- One call, N users, one month. Returns the score AND every counter/date-array
-- the UI renders, so there is exactly one definition of "covered" in the system.
--
-- Two flavours of the present/clock-in counters are returned on purpose:
--   days_clocked_in / days_present      -> WEEKDAY-ONLY (Roster + Performance
--                                          tiles; matches computeMonthlyDays)
--   days_clocked_in_all / days_present_all -> UNFILTERED (the personal card on
--                                          the Attendance page counts weekend
--                                          clock-ins; prod has 12 of them)
-- Dropping either would silently move a tile by a day.
--
-- Returns ZERO ROWS (never raises) for an unauthenticated caller, a malformed
-- month, or a user the caller may not see. Raising would be swallowed by
-- incentivesApi.applyAttendanceAutofill's try/catch and would silently
-- resurrect the stale stored achievedValue.
-- ------------------------------------------------------------
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
  -- A service_role JWT carries no `sub`, so auth.uid() is NULL for it. Without
  -- this bypass the function returns [] to the service_role key (proven against
  -- mig 235's identical gate), which makes the parity harness — the only safety
  -- net this repo has — unrunnable. service_role already bypasses RLS entirely,
  -- so this grants it nothing it did not already have.
  -- nullif(...,'') BEFORE the cast: current_setting(...,true) returns '' (not
  -- NULL) when the GUC has been explicitly set to the empty string, and
  -- ''::jsonb RAISES `invalid input syntax for type json`. This function is
  -- contractually not allowed to raise — incentivesApi.applyAttendanceAutofill
  -- swallows errors and falls back to the STALE stored achievedValue. Supabase's
  -- own auth.uid()/auth.jwt() are written exactly this way.
  --
  -- session_user: a direct psql / SQL-editor session (postgres / supabase_admin)
  -- has no request.jwt.claims at all, so auth.uid() is NULL and the gate would
  -- return zero rows — including for the mandated pre-deploy smoke test. PostgREST
  -- connects as `authenticator` and never as either of these roles, so a web
  -- caller gains nothing from this clause.
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
  -- The month NUMBER must be validated, not just the shape: to_date() does not
  -- raise on '2026-13' — it silently rolls over to 2027-01 and would answer for
  -- a DIFFERENT month ('2026-00' would resolve to 2025-12).
  if p_month is null or p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then return; end if;

  -- Boss / OL / developer / service_role see everyone; everyone else sees
  -- themselves + their DIRECT reports (reports_to covers TL->APC and PCTL->IPC).
  -- Mirrors performanceApi.listEvaluableUsers exactly, so no rendered card can
  -- be left without a row, and an APC cannot read a colleague's breakdown.
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
  v_cutoff := least(v_today, v_end);          -- < v_start for a future month

  -- Future month => 0 elapsed days. Everything downstream must survive it:
  -- generate_series(start, cutoff) yields no rows and pct is NULL (not 0, not
  -- 100 — the consumers each apply their own existing zero-guard).
  v_elapsed := greatest(0, (v_cutoff - v_start) + 1);

  select count(*)::int into v_weekends
    from generate_series(v_start, v_cutoff, interval '1 day') g
   where extract(isodow from g) in (6, 7);

  -- Holidays are WEEKDAY-ONLY, matching holidaysApi.listHolidayDatesForMonth.
  -- A holiday that lands on a Saturday is already covered as a weekend; counting
  -- it twice would double-report the tile.
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
    -- 'wfh' EXCLUDED: those days arrive via a clock-in from home, not as leave.
    -- status='approved' is load-bearing (cancelled requests sit next to approved
    -- ones in the real data). half_leave counts as ONE whole covered day — the
    -- 0.5 in migs 055/159 is leave-QUOTA math, a different domain.
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
    -- SET UNION, never a sum. A day that is both a clock-in and an approved
    -- leave day must count ONCE.
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
    v_elapsed - g.cov,
    -- Every set is clipped to <= cutoff, so covered ⊆ elapsed and the least(100)
    -- can never actually bite. It stays as a belt-and-braces cap.
    case when v_elapsed > 0
         then least(100::numeric, round((g.cov::numeric / v_elapsed::numeric) * 100, 1))
         end,
    -- pct_display is rounded from the EXACT ratio, never from the already-rounded
    -- pct (double-rounding would drift a boundary case).
    case when v_elapsed > 0
         then least(100, round((g.cov::numeric / v_elapsed::numeric) * 100))::int
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

-- ------------------------------------------------------------
-- 2. Single-user wrapper. A thin delegate — there is deliberately NO second
--    copy of the logic. The bulk fn is itself SECURITY DEFINER and re-gates on
--    auth.uid(), so nothing is bypassed by going through here.
-- ------------------------------------------------------------
create or replace function public.attendance_month_breakdown(p_user uuid, p_month text)
returns table (
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
language sql
security definer
set search_path = public
stable
as $$
  select * from public.attendance_month_breakdown_bulk(p_month, array[p_user]);
$$;

revoke execute on function public.attendance_month_breakdown(uuid, text) from public;
revoke execute on function public.attendance_month_breakdown(uuid, text) from anon;
grant  execute on function public.attendance_month_breakdown(uuid, text) to authenticated, service_role;

-- ------------------------------------------------------------
-- 3. perf_attendance_score — SAME SIGNATURE, now a delegate.
--
-- Stops reading performance_config.min_attendance_days (the hardcoded 22).
-- get_performance_composite (mig 125) and incentive_attendance_pct keep
-- compiling untouched.
--
-- One deliberate behaviour change: a caller with no visibility on p_user now
-- gets 0 instead of a real number. That is the point — see the revoke below.
-- ------------------------------------------------------------
create or replace function public.perf_attendance_score(p_user uuid, p_month text)
returns numeric
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_pct numeric;
begin
  select b.pct into v_pct
    from public.attendance_month_breakdown(p_user, p_month) b;
  -- NULL = future month / not visible / no row. mig 120 returned 0 for the same
  -- cases (0 covered / 22), so the incentive fill is unchanged there.
  return coalesce(v_pct, 0);
end;
$$;

revoke execute on function public.perf_attendance_score(uuid, text) from public;
revoke execute on function public.perf_attendance_score(uuid, text) from anon;
grant  execute on function public.perf_attendance_score(uuid, text) to authenticated, service_role;

-- ------------------------------------------------------------
-- 4. incentive_attendance_pct — SAME SIGNATURE, SAME ROW SHAPE, one bulk call.
--
-- mig 235 called perf_attendance_score once PER PROFILE. Now that the score is
-- an 8-CTE engine, that would run the whole engine ~33 times on every
-- /incentives load. The bulk fn re-gates with the identical predicate, so the
-- visible row set and the (user_id, pct) shape are unchanged and
-- src/lib/incentivesApi.js needs zero changes — the number is simply correct now.
-- ------------------------------------------------------------
create or replace function public.incentive_attendance_pct(
  p_month    text,
  p_user_ids uuid[] default null
) returns table(user_id uuid, pct numeric)
language sql
security definer
set search_path = public
stable
as $$
  select b.user_id, coalesce(b.pct, 0)
    from public.attendance_month_breakdown_bulk(p_month, p_user_ids) b;
$$;

revoke execute on function public.incentive_attendance_pct(text, uuid[]) from public;
revoke execute on function public.incentive_attendance_pct(text, uuid[]) from anon;
grant  execute on function public.incentive_attendance_pct(text, uuid[]) to authenticated, service_role;

-- ------------------------------------------------------------
-- 5. att_adjust_bulk_mark_missed — SAME SIGNATURE, missed days now come from
--    the ONE engine.
--
-- The hand-rolled CTEs in mig 120 credited only medical/emergency leave and
-- knew nothing about company_holidays, so this could (and would) stamp a
-- manager adjustment onto Eid or onto an approved half-leave day — and the
-- client's preview count, computed by a different formula, disagreed with what
-- the server actually inserted. Both are fixed by sharing missed_dates.
--
-- Actor gate, _adjust_can_act per target, the notification, the on-conflict
-- and the (users_touched, days_added) OUT names are unchanged.
-- ------------------------------------------------------------
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
  v_actor_id    uuid := auth.uid();
  v_actor_role  text;
  v_actor_name  text;
  v_uid         uuid;
  v_target_role text;
  v_user_added  int;
  v_total_added int := 0;
  v_users       int := 0;
  v_note        text := nullif(trim(coalesce(p_note, '')), '');
begin
  if v_actor_id is null then raise exception 'not authenticated'; end if;
  select p.role, p.display_name into v_actor_role, v_actor_name
    from public.profiles p where p.id = v_actor_id;
  if v_actor_role not in ('boss', 'ol', 'developer') then
    raise exception 'only Boss / OL / Developer can bulk-mark';
  end if;
  -- Validate the month NUMBER too: to_date('2026-00-01') resolves to 2025-12,
  -- so a lax regex here would let this WRITE adjustments into a closed month.
  if p_month is null or p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'month must be YYYY-MM';
  end if;

  foreach v_uid in array coalesce(p_user_ids, '{}'::uuid[]) loop
    select p.role into v_target_role from public.profiles p where p.id = v_uid;
    if v_target_role is null then continue; end if;
    if not public._adjust_can_act(v_actor_id, v_actor_role, v_uid, v_target_role) then
      continue;
    end if;

    -- missed_dates is already: weekdays only (weekends are covered), holidays
    -- excluded, approved leave excluded, clock-ins/adjustments excluded, and
    -- clipped to <= today — so no future date can ever be stamped. The actor is
    -- boss/ol/developer, hence privileged in the breakdown's gate, so this
    -- always returns a row.
    with inserted as (
      insert into public.attendance_adjustments (
        user_id, date, note, bulk, created_by, created_by_role
      )
      select v_uid, m.d::date, v_note, true, v_actor_id, v_actor_role
        from (
          select jsonb_array_elements_text(b.missed_dates) as d
            from public.attendance_month_breakdown(v_uid, p_month) b
        ) m
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

revoke execute on function public.att_adjust_bulk_mark_missed(text, uuid[], text) from public;
revoke execute on function public.att_adjust_bulk_mark_missed(text, uuid[], text) from anon;
grant  execute on function public.att_adjust_bulk_mark_missed(text, uuid[], text) to authenticated, service_role;

-- ------------------------------------------------------------
-- 6. performance_config.min_attendance_days — deprecated, NOT dropped.
--
-- update_performance_config (mig 038) takes p_min_attendance_days as a REQUIRED
-- positional param and the live weights modal still calls it via
-- performanceApi.saveV1Weights. Dropping the column breaks a live save. It just
-- stops being read by any score.
-- ------------------------------------------------------------
comment on column public.performance_config.min_attendance_days is
  'DEPRECATED (mig 252): no score reads this any more. Still written by update_performance_config.';
