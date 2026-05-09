-- ============================================================
-- Migration 126 — Attendance: bring v2 to v1 parity
--
-- This is the schema-and-cron half of porting v1's attendance
-- module verbatim into v2. The UI port lives in JSX; the data
-- model is what the UI hangs off, so we square that first.
--
-- Net effects:
--   1. New columns the v1 calcTimes / acknowledgement / banner
--      flow needs: requested_at, request_time_ms, auto_closed_at,
--      auto_closed_acknowledged.
--   2. att_acknowledge_auto_close() RPC so users can dismiss the
--      banner (already-applied auto-closures shouldn't pester them
--      every login).
--   3. Re-enable the 8-hour pg_cron auto-close (retired in
--      migration 117). Per the new policy:
--        - Cron is the ONLY auto-close mechanism. Closing the
--          session sets auto_closed = true so the user sees a
--          "session was auto-closed at the 8h cap" banner and
--          can dismiss it.
--        - Total work = capped end - clock_in - breaks - request
--          time, with breaks closed at the cap and pending-approval
--          requests treated as auto-approved by the system.
--   4. att_force_close: lock OL out so the only people with manual
--      override are Boss / Developer. Cron handles everyone else.
--      Belt-and-braces: the UI also hides the button for OL.
--
-- Drops nothing. Idempotent.
-- ============================================================

-- ── 1. Columns the v1 calcTimes / banner flow needs ──────────
alter table public.attendance
  add column if not exists requested_at            timestamptz,
  add column if not exists request_time_ms         int,
  add column if not exists auto_closed_at          timestamptz,
  add column if not exists auto_closed_acknowledged boolean not null default false;

-- requested_at gets stamped on att_request_clock_out — patch the
-- existing RPC so APC/IPC clock-out requests record when they
-- entered the queue. Mirrors v1's `requestedAt` field. Keeps the
-- 062 cross-midnight signature.
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
         requested_at   = case when v_new_status = 'pending-approval' then now() else requested_at end,
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

-- ── 2. Acknowledge an auto-close so the banner stops nagging ──
create or replace function public.att_acknowledge_auto_close(p_attendance_id uuid)
returns public.attendance
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.attendance;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  update public.attendance
     set auto_closed_acknowledged = true
   where id = p_attendance_id
     and user_id = v_uid
   returning * into v_row;
  return v_row;
end;
$$;
grant execute on function public.att_acknowledge_auto_close(uuid) to authenticated;

-- ── 3. 8-hour auto-close: re-enable pg_cron + reuse the
--      hardened body from migration 044, with the "this is the
--      only auto-close path" comment updated. ────────────────
create or replace function public.auto_clock_out_overdue_shifts()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row       public.attendance;
  v_count     int := 0;
  v_cap_end   timestamptz;
  v_breaks    jsonb;
  v_last      jsonb;
  v_last_start timestamptz;
  v_last_end   timestamptz;
  v_extra_ms  int;
  v_total_br  int;
  v_req_start timestamptz;
  v_req_ms    int;
begin
  for v_row in
    select * from public.attendance
    where clock_out is null
      and clock_in < now() - interval '8 hours'
      and status in ('clocked-in','on-break','pending-approval')
  loop
    v_cap_end  := v_row.clock_in + interval '8 hours';
    v_breaks   := coalesce(v_row.breaks, '[]'::jsonb);
    v_total_br := coalesce(v_row.total_break_ms, 0);
    v_extra_ms := 0;

    -- Close any still-open break at the cap so we don't lose its
    -- duration when it should be charged inside the 8h window.
    if v_row.status = 'on-break' and jsonb_array_length(v_breaks) > 0 then
      v_last       := v_breaks -> (jsonb_array_length(v_breaks) - 1);
      v_last_start := nullif(v_last ->> 'start', '')::timestamptz;
      v_last_end   := nullif(v_last ->> 'end',   '')::timestamptz;
      if v_last_start is not null and v_last_end is null then
        v_last_end := least(v_cap_end, now());
        v_extra_ms := greatest(0, extract(epoch from (v_last_end - v_last_start))::int * 1000);
        v_breaks := jsonb_set(
          v_breaks,
          array[(jsonb_array_length(v_breaks) - 1)::text],
          v_last || jsonb_build_object('end', v_last_end, 'auto_closed', true)
        );
        v_total_br := v_total_br + v_extra_ms;
      end if;
    end if;

    -- If the user was sitting in pending-approval when the cap
    -- hit, count the wait inside the 8h window so total_work_ms
    -- reflects "actually working" not "waiting for TL".
    v_req_ms := 0;
    if v_row.status = 'pending-approval' and v_row.requested_at is not null then
      v_req_start := greatest(v_row.requested_at, v_row.clock_in);
      v_req_ms := greatest(0, extract(epoch from (least(v_cap_end, now()) - v_req_start))::int * 1000);
    end if;

    update public.attendance
       set status                   = 'clocked-out',
           clock_out                = v_cap_end,
           auto_closed              = true,
           auto_closed_at           = now(),
           auto_closed_acknowledged = false,
           breaks                   = v_breaks,
           total_break_ms           = v_total_br,
           request_time_ms          = v_req_ms,
           total_work_ms            = greatest(
                                        0,
                                        8 * 3600 * 1000 - v_total_br - v_req_ms
                                      ),
           -- If the user had a pending clock-out request when the
           -- cap fired, treat it as auto-approved by the system.
           approval_by              = case when status = 'pending-approval' then null else approval_by end,
           approval_at              = case when status = 'pending-approval' then now() else approval_at end
     where id = v_row.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
grant execute on function public.auto_clock_out_overdue_shifts() to authenticated;

-- (Re-)schedule the cron. Migration 117 unscheduled it; we put it
-- back on a 1-minute cadence so the cap is enforced with at most
-- 60 s of latency. Idempotent — unschedules first.
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
      $cron$select public.auto_clock_out_overdue_shifts();$cron$
    );
  end if;
end;
$$;

-- ── 4. att_force_close: lock OL out (Boss + Developer only) ──
-- Mirror of migration 118's body, with the role gate tightened.
-- The only allowed callers are now Boss and Developer; OL is
-- explicitly removed because the cron handles their use case.
create or replace function public.att_force_close(
  p_attendance_id uuid,
  p_clock_out     timestamptz,
  p_reason        text default null
)
returns public.attendance
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid       uuid := auth.uid();
  v_role      text;
  v_row       public.attendance;
  v_breaks    jsonb;
  v_last      jsonb;
  v_last_start timestamptz;
  v_last_end   timestamptz;
  v_extra_ms  int;
  v_total_br  int;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;

  select role into v_role from public.profiles where id = v_uid;
  if v_role not in ('boss','developer') then
    raise exception 'only Boss / Developer can force-close sessions';
  end if;

  select * into v_row from public.attendance where id = p_attendance_id for update;
  if not found then raise exception 'attendance row not found'; end if;

  if v_row.clock_out is not null and v_row.status = 'clocked-out' then
    return v_row;  -- idempotent
  end if;

  if p_clock_out is null then raise exception 'clock_out timestamp required'; end if;
  if p_clock_out <= v_row.clock_in then
    raise exception 'clock_out must be after clock_in';
  end if;
  if p_clock_out > v_row.clock_in + interval '16 hours' then
    raise exception 'clock_out cannot be more than 16 hours after clock_in';
  end if;
  if p_clock_out > now() then
    raise exception 'clock_out cannot be in the future';
  end if;

  v_breaks   := coalesce(v_row.breaks, '[]'::jsonb);
  v_total_br := coalesce(v_row.total_break_ms, 0);
  v_extra_ms := 0;

  if v_row.status = 'on-break' and jsonb_array_length(v_breaks) > 0 then
    v_last       := v_breaks -> (jsonb_array_length(v_breaks) - 1);
    v_last_start := nullif(v_last ->> 'start', '')::timestamptz;
    v_last_end   := nullif(v_last ->> 'end',   '')::timestamptz;
    if v_last_start is not null and v_last_end is null then
      v_last_end := greatest(v_last_start, p_clock_out);
      v_extra_ms := greatest(0, extract(epoch from (v_last_end - v_last_start))::int * 1000);
      v_breaks := jsonb_set(
        v_breaks,
        array[(jsonb_array_length(v_breaks) - 1)::text],
        v_last || jsonb_build_object('end', v_last_end, 'force_closed', true)
      );
      v_total_br := v_total_br + v_extra_ms;
    end if;
  end if;

  update public.attendance
     set status                  = 'clocked-out',
         clock_out               = p_clock_out,
         breaks                  = v_breaks,
         total_break_ms          = v_total_br,
         total_work_ms           = greatest(
                                     0,
                                     extract(epoch from (p_clock_out - clock_in))::int * 1000
                                     - v_total_br
                                   ),
         auto_closed             = false,
         auto_closed_acknowledged = true,
         closed_by_manager_id    = v_uid,
         closed_by_manager_role  = v_role,
         closed_by_reason        = nullif(trim(coalesce(p_reason, '')), ''),
         closed_by_at            = now()
   where id = p_attendance_id
   returning * into v_row;

  perform public.emit_notification(
    v_row.user_id,
    v_uid,
    'attendance',
    'attendance.force_close',
    'Your session was closed by a manager',
    coalesce(
      nullif(trim(coalesce(p_reason, '')), ''),
      'Your open shift on ' || to_char(v_row.date, 'Mon FMDD') ||
      ' was force-closed at ' || to_char(p_clock_out, 'HH24:MI') || '.'
    ),
    'attendance',
    v_row.id,
    '/attendance'
  );

  return v_row;
end;
$$;
grant execute on function public.att_force_close(uuid, timestamptz, text) to authenticated;
