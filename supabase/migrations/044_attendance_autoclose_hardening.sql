-- ============================================================
-- WurxOS v2 — Migration 044: Attendance auto-close hardening
--
-- Tightens the 8-hour auto-close job so it's provably reliable and
-- handles edge cases that v1 missed:
--   1. If the user is currently on-break when auto-close fires, we
--      close that break first and count it toward total_break_ms.
--   2. Bumps the pg_cron schedule to every minute (was every 5 min)
--      so the cap is enforced with at-most 60 s of latency.
--   3. Keeps the 8-hour cap anchored to clock_in + 8h (NOT now()),
--      so the clock_out timestamp is correct regardless of when the
--      cron actually fires.
-- ============================================================

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

    -- If the user is still on-break, close that last open break at
    -- the cap so we don't lose its duration.
    if v_row.status = 'on-break' and jsonb_array_length(v_breaks) > 0 then
      v_last       := v_breaks -> (jsonb_array_length(v_breaks) - 1);
      v_last_start := nullif(v_last ->> 'start', '')::timestamptz;
      v_last_end   := nullif(v_last ->> 'end',   '')::timestamptz;
      if v_last_start is not null and v_last_end is null then
        -- Cap the break at clock_in + 8h so nothing is charged past the cap.
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

    update public.attendance
       set status         = 'clocked-out',
           clock_out      = v_cap_end,
           auto_closed    = true,
           breaks         = v_breaks,
           total_break_ms = v_total_br,
           total_work_ms  = greatest(0, 8 * 3600 * 1000 - v_total_br)
     where id = v_row.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Bump the schedule to every minute so the cap is enforced promptly.
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
