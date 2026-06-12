-- ============================================================
-- WurxOS v2 — Migration 202: auto-close on REAL session age.
--
-- Bug (prod incident 2026-06-12): the 11h auto-close cron
-- (auto_clock_out_overdue_shifts, mig 154) measured the cap from
-- attendance.clock_in — which is USER-EDITABLE via the edit flow.
-- Employees routinely back-date clock_in to their scheduled shift
-- start (it is always earlier than when they actually pressed
-- "Clock in"), so the cron fired BEFORE 11 real hours — by however
-- much clock_in was back-dated. Worst case: an OL clocked in, briefly
-- mistyped his clock_in as 11h+ ago while correcting it, and the
-- every-minute cron caught that transient value and auto-closed a
-- 23-second-old session. Several users on Jun 10-11 were closed at
-- 5-10 real hours for the same reason.
--
-- Fix: measure the 11-hour cap from created_at (the immutable moment
-- the clock-in row was inserted = when the user really started the
-- session). clock_in edits/back-dates can no longer trigger an early
-- auto-close. For normal sessions (clock_in ~= created_at) behaviour
-- is unchanged. clock_out is capped at created_at + 11h (always after
-- created_at, so no negative durations), and total_work_ms follows the
-- app's calcTimes convention (clock_out - clock_in - breaks).
--
-- The pg_cron schedule (every minute) from mig 154 is unchanged; this
-- only replaces the function body it calls.
--
-- Idempotent.
-- ============================================================

create or replace function public.auto_clock_out_overdue_shifts()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row     public.attendance;
  v_count   int := 0;
  v_cap_end timestamptz;
  v_break_ms int;
begin
  for v_row in
    select * from public.attendance
    where clock_out is null
      -- REAL session age, not the editable clock_in: a session must
      -- have genuinely been open for 11 hours before it is auto-closed.
      and created_at < now() - interval '11 hours'
      and status in ('clocked-in','on-break','pending-approval')
  loop
    v_cap_end  := v_row.created_at + interval '11 hours';
    v_break_ms := coalesce(v_row.total_break_ms, 0);
    update public.attendance
       set status         = 'clocked-out',
           clock_out      = v_cap_end,
           auto_closed    = true,
           auto_closed_at = now(),
           total_work_ms  = greatest(
                              0,
                              extract(epoch from (v_cap_end - clock_in))::int * 1000 - v_break_ms
                            )
     where id = v_row.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
grant execute on function public.auto_clock_out_overdue_shifts() to authenticated;
