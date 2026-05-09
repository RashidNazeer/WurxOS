-- ============================================================
-- Migration 062 — Support shifts that cross midnight
--
-- Shift windows in the office:
--   9am–5pm, 4pm–12am, 6pm–2am
--
-- The 6pm–2am shift (and to a lesser extent 4pm–12am) closes on
-- the *next* calendar day. The original RPCs in 030 filtered
-- `where user_id = v_uid and date = current_date` — so a Monday
-- 6pm clock-in, clocked out Tuesday 2am, would find nothing on
-- Tuesday and silently no-op. Breaks had the same problem.
--
-- Fix: clock-out and break RPCs now find the user's *latest open*
-- row (clock_out is null, status in ('clocked-in','on-break',
-- 'pending-approval')) regardless of date. The row stays attached
-- to the day the shift STARTED, which is what the user wants.
--
-- Also:
--   - att_clock_in guards against opening a new day's row when a
--     prior day's shift is still open (forces close-first).
--   - auto_clock_out_overdue_shifts cap raised from 8h to 10h so
--     it doesn't clobber an 8h night shift that's still running.
-- ============================================================

-- --------------------------------------------------------------
-- Clock-in: block if there's still an open shift from earlier
-- --------------------------------------------------------------
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

  -- If a prior shift is still open, refuse — the user must clock
  -- that one out first. (Today's open row is fine: we'll upsert.)
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

  insert into public.attendance (user_id, date, location, status, clock_in)
  values (v_uid, current_date, p_location, 'clocked-in', now())
  on conflict (user_id, date) do update
    set status   = 'clocked-in',
        clock_in = coalesce(public.attendance.clock_in, now()),
        location = excluded.location
    where public.attendance.clock_out is null
  returning * into v_row;
  return v_row;
end;
$$;
grant execute on function public.att_clock_in(text) to authenticated;

-- --------------------------------------------------------------
-- Helper: pick the user's latest open row (cross-day safe)
-- --------------------------------------------------------------
create or replace function public._att_latest_open(p_uid uuid)
returns public.attendance
language sql
stable
security definer
set search_path = public
as $$
  select * from public.attendance
   where user_id = p_uid
     and clock_out is null
     and status in ('clocked-in','on-break','pending-approval')
   order by clock_in desc
   limit 1;
$$;

-- --------------------------------------------------------------
-- Clock-out (with optional note) — matches latest open row
-- --------------------------------------------------------------
create or replace function public.att_request_clock_out(p_note text default null)
returns public.attendance
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_role text;
  v_row  public.attendance;
  v_end  timestamptz := now();
  v_new_status text;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;

  select * into v_row from public.attendance
    where id = (select id from public._att_latest_open(v_uid))
    for update;

  if not found then
    raise exception 'no active shift to clock out from';
  end if;

  if v_row.status in ('clocked-out','pending-approval') and v_row.clock_out is not null then
    return v_row;  -- idempotent
  end if;

  select role into v_role from public.profiles where id = v_uid;
  v_new_status := case when v_role in ('apc','ipc') then 'pending-approval' else 'clocked-out' end;

  update public.attendance
     set status         = v_new_status,
         clock_out_note = coalesce(p_note, clock_out_note),
         clock_out      = case when v_new_status = 'clocked-out' then v_end else clock_out end,
         total_work_ms  = case when v_new_status = 'clocked-out'
                               then greatest(0, extract(epoch from (v_end - clock_in))::int * 1000
                                    - coalesce(total_break_ms, 0))
                               else total_work_ms end
   where id = v_row.id
   returning * into v_row;
  return v_row;
end;
$$;
grant execute on function public.att_request_clock_out(text) to authenticated;

create or replace function public.att_request_clock_out()
returns public.attendance
language sql
security definer
set search_path = public
as $$
  select public.att_request_clock_out(null::text);
$$;
grant execute on function public.att_request_clock_out() to authenticated;

-- --------------------------------------------------------------
-- Break start / end — also match the latest open row
-- --------------------------------------------------------------
create or replace function public.att_start_break()
returns public.attendance
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_row  public.attendance;
  v_id   uuid;
  v_breaks jsonb;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;

  select id into v_id from public._att_latest_open(v_uid);
  if v_id is null then raise exception 'no active shift to start a break'; end if;

  select breaks into v_breaks from public.attendance where id = v_id for update;
  v_breaks := coalesce(v_breaks, '[]'::jsonb)
              || jsonb_build_array(jsonb_build_object('start', now()));
  update public.attendance
     set breaks = v_breaks, status = 'on-break'
   where id = v_id
   returning * into v_row;
  return v_row;
end;
$$;
grant execute on function public.att_start_break() to authenticated;

create or replace function public.att_end_break()
returns public.attendance
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_row  public.attendance;
  v_id   uuid;
  v_breaks jsonb;
  v_last  jsonb;
  v_start timestamptz;
  v_add_ms int;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;

  select id into v_id from public._att_latest_open(v_uid);
  if v_id is null then return null; end if;

  select breaks into v_breaks from public.attendance where id = v_id for update;
  if v_breaks is null or jsonb_array_length(v_breaks) = 0 then return null; end if;

  v_last := v_breaks -> (jsonb_array_length(v_breaks) - 1);
  v_start := (v_last ->> 'start')::timestamptz;
  v_add_ms := greatest(0, extract(epoch from (now() - v_start))::int * 1000);
  v_breaks := jsonb_set(v_breaks, array[(jsonb_array_length(v_breaks) - 1)::text],
                        v_last || jsonb_build_object('end', now()));
  update public.attendance
     set breaks         = v_breaks,
         total_break_ms = coalesce(total_break_ms, 0) + v_add_ms,
         status         = 'clocked-in'
   where id = v_id
   returning * into v_row;
  return v_row;
end;
$$;
grant execute on function public.att_end_break() to authenticated;

-- --------------------------------------------------------------
-- Auto-clock-out: raise cap to 10h so 8h night shifts survive
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
begin
  for v_row in
    select * from public.attendance
    where clock_out is null
      and clock_in < now() - interval '10 hours'
      and status in ('clocked-in','on-break','pending-approval')
  loop
    v_cap_end := v_row.clock_in + interval '10 hours';
    update public.attendance
       set status        = 'clocked-out',
           clock_out     = v_cap_end,
           auto_closed   = true,
           total_work_ms = greatest(0, 10 * 3600 * 1000 - coalesce(total_break_ms, 0))
     where id = v_row.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
