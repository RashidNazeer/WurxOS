-- ============================================================
-- WurxOS v2 — Migration 254: "you forgot to clock in" reminder.
--
-- People forget to clock in. There's a popup that nudges them ~1h after their
-- shift starts IF they still haven't. The hard part isn't the popup — it's that
-- the app has never stored when anyone's shift starts (attendance is purely
-- presence-based: clock_in = now() when you tap the button). So each person now
-- sets their own shift start, ALWAYS in Pakistan time (Asia/Karachi), and this
-- migration owns two things:
--
--   1. profiles.shift_start_time — a bare wall-clock TIME, defined as PKT. It
--      carries no timezone by design: the user types it as PKT and every
--      comparison below is done in PKT, so a laptop set to another zone can't
--      contaminate it. NULL = the person hasn't opted in → never remind them.
--
--   2. attendance_should_remind_clock_in() — one function that does all the PKT
--      math and returns a plain verdict, so the client stays dumb and the
--      shift-day / leave / holiday logic lives in exactly one place (here),
--      testable against the live DB.
--
-- The verdict is TRUE only when EVERY one of these holds — each clause kills a
-- specific false-positive (the whole point: never nag someone who's fine):
--   * not Boss, and a shift start is set        (Boss/opted-out)
--   * no attendance row for today's shift-day    (already clocked in / on break
--                                                 / OR did their shift & left)
--   * now ∈ [shiftStart+1h, shiftStart+10h]      (too early / stale next-day)
--   * shift-day isn't a weekend                  (their day off)
--   * shift-day isn't a company holiday          (Eid etc.)
--   * no approved non-WFH leave covers it        (on leave — WFH still clocks in)
--
-- The 3pm-PKT shift-day rollover (public._shift_day, mig 154) is reused so a
-- shift that starts in the evening and runs past midnight stays on one day.
-- Idempotent.
-- ============================================================

-- 1. Storage --------------------------------------------------------------
alter table public.profiles
  add column if not exists shift_start_time time;

comment on column public.profiles.shift_start_time is
  'Wall-clock shift start, interpreted as Asia/Karachi (PKT). NULL = no clock-in reminder.';

-- 2. Self-service setter (validates + scopes to the caller) ----------------
-- A user only ever sets their OWN shift start. SECURITY DEFINER so it doesn't
-- depend on the exact shape of the profiles UPDATE policy, and so we can
-- validate rather than trust a raw column write. Pass NULL to turn it off.
create or replace function public.att_set_my_shift_start(p_time time)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.profiles;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  update public.profiles
     set shift_start_time = p_time, updated_at = now()
   where id = v_uid
   returning * into v_row;
  if not found then
    raise exception 'profile not found';
  end if;
  return v_row;
end;
$$;
grant execute on function public.att_set_my_shift_start(time) to authenticated;

-- 3. The decision engine --------------------------------------------------
-- Returns one row. `remind` is the only field the popup needs; `reason`,
-- `shift_start`, `shift_day` are for display + debugging + testing.
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

  if not coalesce(v_active, false) then reason := 'inactive';         return next; return; end if;
  if v_role = 'boss'                then reason := 'boss';             return next; return; end if;
  if v_start is null                then reason := 'no-shift-set';     return next; return; end if;

  -- Which shift-day are we in right now (3pm PKT rollover).
  v_shift_day := public._shift_day(v_now);
  shift_day := v_shift_day;

  -- Already have an attendance row for this shift-day? Then they've clocked in
  -- (in / on-break / pending) OR already did their shift and clocked out.
  if exists (select 1 from public.attendance
              where user_id = v_uid and date = v_shift_day) then
    reason := 'already-has-record'; return next; return;
  end if;

  -- Anchor the shift start to this shift-day's actual wall-clock instant.
  -- Evening starts (>=15:00) sit on the shift-day date; a start that falls on
  -- the far side of the 3pm boundary belongs to the next calendar day.
  v_start_ts := (v_shift_day::text || ' ' || v_start::text)::timestamp
                  at time zone 'Asia/Karachi';
  if public._shift_day(v_start_ts) <> v_shift_day then
    v_start_ts := v_start_ts + interval '1 day';
  end if;
  starts_at := v_start_ts;

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
  -- later). Before the window → too early; after → a missed-day matter, not a
  -- "clock in now" nudge.
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
grant execute on function public.attendance_should_remind_clock_in() to authenticated;
