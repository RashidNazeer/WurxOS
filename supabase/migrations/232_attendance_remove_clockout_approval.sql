-- ============================================================
-- WurxOS v2 — Migration 232: remove the clock-out approval step.
--
-- Ops decision (2026-07-07): APC/IPC clock-outs no longer require Team Lead
-- approval. Everyone now clocks out DIRECTLY — no 'pending-approval' state,
-- no TL sign-off, no waiting. Previously mig 144 routed APC/IPC clock-outs to
-- a TL approval queue whenever the TL was clocked in; that gate is removed.
--
-- Changes:
--   * att_request_clock_out: always transition the open shift straight to
--     'clocked-out' (final clock_out + total_work_ms) for EVERY role. The
--     pending-approval branch is gone.
--   * Close out any lingering 'pending-approval' rows (backlog) using their
--     existing clock_out time, so nobody is left stuck waiting on a TL.
--
-- LEFT IN PLACE (go idle, no new pending rows): the approval RPC
-- att_approve_clock_out and the manager "Pending clock-out approvals" UI — so
-- re-enabling the step later is just reverting this one function. The separate
-- att_request_edit offline-auto-approve for time EDITS is unchanged.
-- Safe to re-run.
-- ============================================================

create or replace function public.att_request_clock_out(p_note text default null)
returns public.attendance
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_row  public.attendance;
  v_end  timestamptz := now();
begin
  if v_uid is null then raise exception 'not authenticated'; end if;

  select * into v_row from public.attendance
    where id = (select id from public._att_latest_open(v_uid))
    for update;

  if not found then
    raise exception 'no active shift to clock out from';
  end if;

  -- Idempotent: already closed → return as-is (covers double-tap / a row that
  -- was auto-closed between fetch and update).
  if v_row.clock_out is not null then
    return v_row;
  end if;

  -- Clock-out approval REMOVED — straight to clocked-out for every role.
  update public.attendance
     set status         = 'clocked-out',
         clock_out_note = coalesce(p_note, clock_out_note),
         clock_out      = v_end,
         total_work_ms  = greatest(0, extract(epoch from (v_end - clock_in))::int * 1000
                              - coalesce(total_break_ms, 0))
   where id = v_row.id
   returning * into v_row;

  return v_row;
end;
$$;
grant execute on function public.att_request_clock_out(text) to authenticated;

-- Clear the old approval backlog: close any clock-outs still stuck in
-- 'pending-approval' with their already-recorded clock_out time.
update public.attendance
   set status        = 'clocked-out',
       total_work_ms  = greatest(0, extract(epoch from (clock_out - clock_in))::int * 1000
                           - coalesce(total_break_ms, 0))
 where status = 'pending-approval'
   and clock_out is not null;
