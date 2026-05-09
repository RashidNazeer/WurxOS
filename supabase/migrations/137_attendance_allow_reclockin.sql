-- ============================================================
-- Migration 137 — allow re-clock-in same day after a clock-out
--
-- Symptom (reported 2026-05-08): user clocks in, clocks out, then
-- can't clock in again — UI says it worked but DB shows no change.
--
-- Root cause: `att_clock_in` (mig 062) had this conflict path:
--
--   on conflict (user_id, date) do update
--     set status = 'clocked-in', clock_in = coalesce(..., now()), ...
--     where public.attendance.clock_out is null
--
-- The `WHERE public.attendance.clock_out is null` filter on the
-- ON CONFLICT branch means: if the existing row already has a
-- clock_out (i.e. user clocked out today and is now trying to
-- clock back in), the UPDATE is a no-op and the function returns
-- NULL silently. The frontend thinks it succeeded, but no shift
-- was opened.
--
-- Fix: drop the WHERE clause, and when re-clocking in same day
-- explicitly clear clock_out (so a fresh shift starts) AND reset
-- clock_in to now. Also reset auto_closed flags so the new shift
-- isn't pre-tagged as auto-closed.
--
-- The cross-day guard (refusing to clock in when there's an open
-- shift from a previous day) is preserved.
-- ============================================================

create or replace function public.att_clock_in(p_location text default 'wfh')
returns public.attendance
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_open public.attendance;
  v_row  public.attendance;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;

  -- If a prior shift from a DIFFERENT day is still open, refuse —
  -- the user must clock that one out first.
  select * into v_open from public.attendance
    where user_id = v_uid
      and clock_out is null
      and status in ('clocked-in','on-break','pending-approval')
      and date <> current_date
    order by clock_in desc
    limit 1;

  if found then
    raise exception 'you still have an open shift from % — clock out first', v_open.date;
  end if;

  -- Insert today's row, or upsert if it already exists (could be a
  -- closed shift from earlier today that we're re-opening, or the
  -- normal first clock-in case).
  insert into public.attendance (user_id, date, location, status, clock_in)
  values (v_uid, current_date, p_location, 'clocked-in', now())
  on conflict (user_id, date) do update
    set status         = 'clocked-in',
        clock_in       = now(),                 -- start a fresh shift
        clock_out      = null,                  -- clear previous clock-out
        location       = excluded.location,
        auto_closed    = false,
        auto_closed_at = null,
        auto_closed_acknowledged = false,
        clock_out_note = null
  returning * into v_row;

  return v_row;
end;
$$;
grant execute on function public.att_clock_in(text) to authenticated;
