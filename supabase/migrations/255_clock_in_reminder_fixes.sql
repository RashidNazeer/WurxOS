-- ============================================================
-- WurxOS v2 — Migration 255: two fixes to the clock-in reminder (mig 254),
-- found by adversarial review before it shipped.
--
-- (1) THE [14:00, 15:00) DEAD ZONE.
--     254 derived the shift-day from now() and then anchored the shift start
--     to it (with a +1-day correction). For a shift starting in the last hour
--     before the 3pm shift-day rollover, the 1-hour grace pushed the window's
--     start onto/past the rollover, so the window was only ever evaluated
--     against the NEXT shift-day, where it looked not-yet-started — and the
--     reminder silently never fired. Our org runs evening shifts so nobody was
--     likely to set a ~2pm start, but "silently never fires for a value you can
--     enter" is a real trap.
--
--     Fix: anchor to the MOST RECENT occurrence of the shift start at or before
--     now, and derive the shift-day from THAT. This decouples the window from
--     the rollover entirely — every shift start from 00:00 to 23:59 now fires
--     correctly, and evening/late/morning behaviour is unchanged (verified
--     against the same test matrix, 16/16).
--
-- (2) SECURITY DEFINER functions were still PUBLIC/anon-callable. Both guard on
--     auth.uid() so nothing leaked or was writable, but a bare grant to
--     `authenticated` doesn't remove Postgres's default grant to PUBLIC — so
--     revoke it, matching the standard mig 252 set for attendance functions.
--
-- Idempotent.
-- ============================================================

create or replace function public.attendance_should_remind_clock_in()
returns table (
  remind      boolean,
  reason      text,
  shift_start time,
  shift_day   date,
  starts_at   timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid       uuid := auth.uid();
  v_role      text;
  v_active    boolean;
  v_start     time;
  v_today     date;
  v_shift_day date;
  v_start_ts  timestamptz;
  v_now       timestamptz := now();
begin
  remind := false; reason := ''; shift_start := null; shift_day := null; starts_at := null;

  if v_uid is null then
    reason := 'not-authenticated'; return next; return;
  end if;

  select role, is_active, shift_start_time
    into v_role, v_active, v_start
    from public.profiles where id = v_uid;

  shift_start := v_start;

  if not coalesce(v_active, false) then reason := 'inactive';     return next; return; end if;
  if v_role = 'boss'                then reason := 'boss';         return next; return; end if;
  if v_start is null                then reason := 'no-shift-set'; return next; return; end if;

  -- The most recent instant the shift started, at or before now (PKT). Building
  -- it from today's PKT date and stepping back a day if that's still in the
  -- future gives the correct anchor for every shift time, with no dependence on
  -- the 3pm rollover.
  v_today    := (v_now at time zone 'Asia/Karachi')::date;
  v_start_ts := (v_today::text || ' ' || v_start::text)::timestamp
                  at time zone 'Asia/Karachi';
  if v_start_ts > v_now then
    v_start_ts := v_start_ts - interval '1 day';
  end if;

  -- The shift-day this shift belongs to — the same bucket att_clock_in would
  -- key its row on, so the record check lines up exactly.
  v_shift_day := public._shift_day(v_start_ts);
  shift_day := v_shift_day;
  starts_at := v_start_ts;

  -- Already have an attendance row for this shift-day? Then they've clocked in
  -- (in / on-break / pending) OR already did their shift and clocked out.
  if exists (select 1 from public.attendance
              where user_id = v_uid and date = v_shift_day) then
    reason := 'already-has-record'; return next; return;
  end if;

  -- Weekend (of the shift-day) — their day off.
  if extract(isodow from v_shift_day) in (6, 7) then
    reason := 'weekend'; return next; return;
  end if;

  -- Company holiday covering the shift-day.
  if exists (select 1 from public.company_holidays h
              where v_shift_day between h.start_date and h.end_date) then
    reason := 'holiday'; return next; return;
  end if;

  -- Approved leave covering the shift-day — every type except WFH (a WFH day is
  -- still a clock-in). Mirrors the attendance-score "covered" set.
  if exists (select 1 from public.leave_requests lr
              where lr.requester_id = v_uid
                and lr.status = 'approved'
                and lr.type in ('medical','emergency','half_leave','other')
                and v_shift_day between lr.start_date and lr.end_date) then
    reason := 'on-leave'; return next; return;
  end if;

  -- Timing window: from 1h after the shift start, until it's stale (~a shift
  -- later). Before → too early; after → a missed-day matter, not a nudge.
  if v_now < v_start_ts + interval '1 hour' then
    reason := 'before-grace'; return next; return;
  end if;
  if v_now >= v_start_ts + interval '10 hours' then
    reason := 'window-passed'; return next; return;
  end if;

  remind := true; reason := 'remind';
  return next;
end;
$$;

revoke all on function public.attendance_should_remind_clock_in() from public, anon;
grant execute on function public.attendance_should_remind_clock_in() to authenticated;

revoke all on function public.att_set_my_shift_start(time) from public, anon;
grant execute on function public.att_set_my_shift_start(time) to authenticated;
