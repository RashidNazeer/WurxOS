-- ============================================================
-- WurxOS v2 — Migration 154: night-shift-aware shift day
--
-- Background: WurxCrew runs two night shifts that span midnight —
-- 4pm–12am and 6pm–2am. The attendance table previously keyed
-- rows by `current_date` (UTC midnight), so a clock-in at 5am PKT
-- (still part of the previous night's 6pm–2am shift) ended up as
-- a NEW row for the next calendar day instead of attaching to the
-- shift that already started. The user's UI then showed bizarre
-- entries like "May 9 row with 5:22 AM May 8 clock-in" — the
-- 5am clock-in actually belonged to the May 8 shift.
--
-- Fix:
--   * New helper `_shift_day(ts)`: returns the shift-day date by
--     shifting the timestamp back 15 hours in Asia/Karachi time.
--     This means the shift day rolls over at 3pm PKT each day —
--     well before the 4pm earliest shift start, giving us a clean
--     buffer.
--   * `att_clock_in` uses `_shift_day(now())` instead of `current_date`.
--   * Re-clock-in on the SAME shift day is blocked with a clear
--     error. Once the user clocks in (or even has a clocked-out
--     row) for today's shift, they cannot clock in again until
--     the next shift day begins (3pm PKT next calendar day).
--   * Auto-close cap raised to 11 hours and the pg_cron job is
--     re-enabled (was neutered in mig 117). Sets auto_closed=true
--     and a timestamp; the UI shows the 'Auto-closed' badge.
--
-- Safe to re-run.
-- ============================================================

-- --------------------------------------------------------------
-- 1. _shift_day helper
-- --------------------------------------------------------------
create or replace function public._shift_day(p_ts timestamptz)
returns date
language sql
immutable
set search_path = public
as $$
  -- Subtract 15 hours so the boundary between shift days is 3pm PKT.
  -- 3pm PKT = (PKT timestamp) - 15h still in same calendar day.
  -- 2pm PKT = (PKT timestamp) - 15h crosses into previous calendar day.
  select ((p_ts at time zone 'Asia/Karachi') - interval '15 hours')::date;
$$;
grant execute on function public._shift_day(timestamptz) to authenticated;

-- --------------------------------------------------------------
-- 2. att_clock_in — keyed on shift day, block re-clock-in
-- --------------------------------------------------------------
create or replace function public.att_clock_in(p_location text default 'wfh')
returns public.attendance
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid       uuid := auth.uid();
  v_shift_day date;
  v_open      public.attendance;
  v_existing  public.attendance;
  v_row       public.attendance;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  v_shift_day := public._shift_day(now());

  -- Block 1: any prior shift on an EARLIER shift day that's still
  -- open. The user must clock that one out first.
  select * into v_open from public.attendance
    where user_id = v_uid
      and clock_out is null
      and status in ('clocked-in','on-break','pending-approval')
      and date <> v_shift_day
    order by clock_in desc
    limit 1;

  if found then
    raise exception
      'you still have an open shift from % — clock out first', v_open.date;
  end if;

  -- Block 2: a row for today's shift day already exists — even if it
  -- was clocked out. Once you clock in (and out) for today's shift,
  -- you can't start another one for the same shift day. The next
  -- shift starts at 3pm PKT tomorrow.
  select * into v_existing from public.attendance
    where user_id = v_uid
      and date = v_shift_day
    limit 1;

  if found and v_existing.clock_out is not null then
    raise exception
      'you already clocked in for today''s shift at % (and clocked out at %). The next shift starts at 3pm PKT tomorrow.',
      to_char(v_existing.clock_in  at time zone 'Asia/Karachi', 'HH12:MI AM'),
      to_char(v_existing.clock_out at time zone 'Asia/Karachi', 'HH12:MI AM');
  end if;

  -- Insert a fresh row for the shift day, or upsert if there's an
  -- existing OPEN row (handles double-tap on clock-in).
  insert into public.attendance (user_id, date, location, status, clock_in)
  values (v_uid, v_shift_day, p_location, 'clocked-in', now())
  on conflict (user_id, date) do update
    set status         = 'clocked-in',
        clock_in       = coalesce(public.attendance.clock_in, now()),
        location       = excluded.location,
        auto_closed    = false,
        auto_closed_at = null,
        auto_closed_acknowledged = false,
        clock_out_note = null
    where public.attendance.clock_out is null
  returning * into v_row;

  return v_row;
end;
$$;
grant execute on function public.att_clock_in(text) to authenticated;

-- --------------------------------------------------------------
-- 3. Auto-close: 11-hour cap, re-enable pg_cron
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
  v_break_ms int;
begin
  for v_row in
    select * from public.attendance
    where clock_out is null
      and clock_in < now() - interval '11 hours'
      and status in ('clocked-in','on-break','pending-approval')
  loop
    v_cap_end := v_row.clock_in + interval '11 hours';
    v_break_ms := coalesce(v_row.total_break_ms, 0);
    update public.attendance
       set status         = 'clocked-out',
           clock_out      = v_cap_end,
           auto_closed    = true,
           auto_closed_at = now(),
           total_work_ms  = greatest(0, 11 * 3600 * 1000 - v_break_ms)
     where id = v_row.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
grant execute on function public.auto_clock_out_overdue_shifts() to authenticated;

-- Re-enable the pg_cron schedule (unscheduled by mig 117). Runs
-- every minute so the cap is enforced promptly.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      perform cron.unschedule('auto-clock-out-overdue');
    exception when others then null;
    end;
    perform cron.schedule(
      'auto-clock-out-overdue',
      '* * * * *',
      $cron$ select public.auto_clock_out_overdue_shifts(); $cron$
    );
  end if;
end;
$$;
