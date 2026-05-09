-- ============================================================
-- WurxOS v2 — Migration 144: auto-approve APC clock-out / edits
-- when their TL is not currently clocked-in.
--
-- Background: APC/IPC clock-out routes through a TL approval queue.
-- Same for time-edit requests. Users complained that when their TL
-- is off the clock, their clock-out / edit gets stuck in
-- 'pending-approval' indefinitely. New rule: if the requester's
-- direct manager (profiles.reports_to) does NOT have an open
-- attendance shift right now (clock_in today AND clock_out is
-- still null AND status in clocked-in / on-break), auto-approve.
--
--  * att_request_clock_out  → if TL offline, status = clocked-out.
--  * att_request_edit       → if TL offline, mark edit approved
--                             and apply it to the attendance row.
--
-- If the user has no reports_to (e.g. TL/PCTL themselves) the
-- code paths still treat them as 'no pending approval needed'
-- exactly as before. Only APC/IPC require approval at all.
--
-- Safe to re-run.
-- ============================================================

-- helper: is the manager of `p_uid` currently in an open shift?
create or replace function public._att_manager_online(p_uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
      from public.profiles p
      join public.attendance a on a.user_id = p.reports_to
     where p.id = p_uid
       and p.reports_to is not null
       and a.clock_in::date = (now() at time zone 'UTC')::date
       and a.clock_out is null
       and a.status in ('clocked-in','on-break')
  );
$$;
grant execute on function public._att_manager_online(uuid) to authenticated;

-- ── 1. Clock-out: if requester is APC/IPC AND their TL is offline,
--      skip the queue and clock them out immediately. ──
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
  v_needs_approval boolean;
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

  -- APC/IPC normally need approval — but only if their TL is
  -- currently clocked-in. If TL is offline we auto-approve.
  v_needs_approval := v_role in ('apc','ipc')
                       and public._att_manager_online(v_uid);
  v_new_status := case when v_needs_approval then 'pending-approval' else 'clocked-out' end;

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

-- ── 2. Edit request: if requester's TL is offline, mark the new
--      request immediately approved and apply the change. ──
create or replace function public.att_request_edit(
  p_attendance_id uuid,
  p_field         text,         -- 'clock_in' | 'clock_out'
  p_requested     timestamptz,
  p_reason        text
)
returns public.attendance_edit_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me    uuid := auth.uid();
  v_att   public.attendance;
  v_row   public.attendance_edit_requests;
  v_role  text;
  v_auto  boolean;
  v_new_work_ms int;
begin
  if v_me is null then raise exception 'not authenticated'; end if;
  if p_field not in ('clock_in','clock_out') then raise exception 'bad field'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'reason required'; end if;

  select * into v_att from public.attendance where id = p_attendance_id;
  if not found             then raise exception 'attendance row not found'; end if;
  if v_att.user_id <> v_me then raise exception 'can only edit your own attendance'; end if;

  if exists (
    select 1 from public.attendance_edit_requests
     where attendance_id = p_attendance_id and field = p_field and status = 'pending'
  ) then
    raise exception 'a pending edit request already exists for this field';
  end if;

  insert into public.attendance_edit_requests
    (attendance_id, user_id, field, requested_value, reason)
    values (p_attendance_id, v_me, p_field, p_requested, trim(p_reason))
  returning * into v_row;

  -- Decide auto-approval: APC/IPC may auto-apply when TL is offline.
  -- Other roles fall through to the normal manager queue (no auto).
  select role into v_role from public.profiles where id = v_me;
  v_auto := v_role in ('apc','ipc') and not public._att_manager_online(v_me);

  if v_auto then
    -- Apply the edit immediately.
    if p_field = 'clock_in' then
      update public.attendance
         set clock_in = p_requested
       where id = v_att.id
       returning * into v_att;
    else
      update public.attendance
         set clock_out = p_requested,
             status    = case when status = 'pending-approval' then 'clocked-out' else status end
       where id = v_att.id
       returning * into v_att;
    end if;
    if v_att.clock_in is not null and v_att.clock_out is not null then
      v_new_work_ms := greatest(0,
        extract(epoch from (v_att.clock_out - v_att.clock_in))::int * 1000
        - coalesce(v_att.total_break_ms, 0));
      update public.attendance set total_work_ms = v_new_work_ms where id = v_att.id;
    end if;

    update public.attendance_edit_requests
       set status        = 'approved',
           decided_by    = v_me,                -- self-approved (TL offline)
           decided_at    = now(),
           decision_note = 'auto-approved (TL offline)'
     where id = v_row.id
     returning * into v_row;
  else
    -- Notify the manager (or Boss fallback) just like before.
    declare v_mgr uuid; v_name text;
    begin
      select coalesce(reports_to, (
        select id from public.profiles where role = 'boss' and is_active = true
        order by created_at asc limit 1
      )) into v_mgr
        from public.profiles where id = v_me;
      v_name := coalesce(public.profile_display_name(v_me), 'Someone');
      if v_mgr is not null and v_mgr <> v_me then
        perform public.emit_notification(
          v_mgr, v_me, 'system', 'attendance.edit_requested',
          'Attendance edit request',
          v_name || ' requested an edit to their ' || replace(p_field, '_', '-') || ' time.',
          'attendance', p_attendance_id, '/attendance'
        );
      end if;
    end;
  end if;

  return v_row;
end;
$$;
grant execute on function public.att_request_edit(uuid, text, timestamptz, text) to authenticated;
