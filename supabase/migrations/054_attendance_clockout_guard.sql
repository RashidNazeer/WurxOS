-- ============================================================
-- Migration 054 — guard against double clock-out on the same day.
--
-- The original att_request_clock_out updates the row without checking
-- whether clock_out is already set. A second call (accidental click,
-- race condition) would overwrite the original clock_out timestamp
-- with `now()` and recompute total_work_ms against a far-later end
-- time — silently corrupting the record.
--
-- The guard below makes a second call a no-op: if the row is already
-- clocked-out or in pending-approval, we return the existing row
-- unchanged rather than mutate it.
-- ============================================================

create or replace function public.att_request_clock_out()
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
    where user_id = v_uid and date = current_date
    for update;

  if not found then
    raise exception 'no active shift to clock out from';
  end if;

  -- Already wrapped up — return as-is, don't overwrite clock_out/total_work_ms.
  if v_row.status in ('clocked-out', 'pending-approval') then
    return v_row;
  end if;

  select role into v_role from public.profiles where id = v_uid;
  v_new_status := case when v_role in ('apc','ipc') then 'pending-approval' else 'clocked-out' end;

  update public.attendance
     set status = v_new_status,
         clock_out = case when v_new_status = 'clocked-out' then v_end else clock_out end,
         total_work_ms = case when v_new_status = 'clocked-out'
                              then greatest(0, extract(epoch from (v_end - clock_in))::int * 1000
                                   - coalesce(total_break_ms, 0))
                              else total_work_ms end
   where id = v_row.id
   returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.att_request_clock_out() to authenticated;
