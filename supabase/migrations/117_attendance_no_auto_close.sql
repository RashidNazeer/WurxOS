-- ============================================================
-- Migration 117 — Drop hard auto-close; in-app reminder + recovery
--
-- Policy change: sessions are NOT auto-closed at 8h. Overtime is
-- supported. The UX layer drives soft thresholds:
--   REMINDER (9h)  → non-blocking "still working?" banner
--   STALE   (14h, or rolled into next calendar day) → recovery
--                    prompt asking when the user actually stopped
--
-- This migration:
--   1. Unschedules the every-minute pg_cron auto-close job.
--   2. Neuters auto_clock_out_overdue_shifts() to a no-op (kept so
--      anything still calling it compiles; remove call sites in a
--      future cleanup).
--   3. Adds attendance.still_working_ack_at (timestamptz, null) to
--      track when the user has acknowledged the 9h banner. The
--      banner is suppressed for ~3h after this is set; client logic.
--   4. Adds att_mark_still_working() RPC so any signed-in user can
--      stamp their own latest open row.
-- ============================================================

-- 1. Drop the pg_cron schedule (idempotent).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      perform cron.unschedule('auto-clock-out-overdue');
    exception when others then null;
    end;
  end if;
end;
$$;

-- 2. Neuter the function so the table sees no further auto-close
--    writes. We keep it as a no-op rather than dropping, so that
--    any RPC/trigger/cron we forgot doesn't error. Remove fully in
--    a later cleanup once we're sure nothing references it.
create or replace function public.auto_clock_out_overdue_shifts()
returns int
language sql
security definer
set search_path = public
as $$
  -- Retired: hard auto-close replaced by client-side reminder
  -- (REMINDER at 9h) and recovery prompt (STALE at 14h or next
  -- calendar day) per migration 117.
  select 0::int;
$$;

-- 3. Acknowledgement column for the still-working banner.
alter table public.attendance
  add column if not exists still_working_ack_at timestamptz;

-- 4. Self-service RPC: stamp the caller's latest open row.
create or replace function public.att_mark_still_working()
returns public.attendance
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_id  uuid;
  v_row public.attendance;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select id into v_id from public._att_latest_open(v_uid);
  if v_id is null then return null; end if;
  update public.attendance
     set still_working_ack_at = now()
   where id = v_id
   returning * into v_row;
  return v_row;
end;
$$;
grant execute on function public.att_mark_still_working() to authenticated;
