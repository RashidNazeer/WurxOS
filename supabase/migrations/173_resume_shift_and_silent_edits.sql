-- ============================================================
-- WurxOS v2 — Migration 173: resume an accidental clock-out +
-- silence manager direct-edit notifications.
--
-- Two user requests (2026-05-15):
--
-- 1. Accidental clock-out. If a user clicks "Clock out" by mistake
--    they're locked out until the next shift day (mig 154 Block 2).
--    New att_resume_shift() reopens TODAY's shift as if the
--    clock-out never happened — clock_out cleared, status back to
--    clocked-in, the live timer picks up from the original
--    clock-in so no worked time is lost. Bounded to the current
--    shift day; auto-closed shifts are excluded (those go through
--    the manager edit-request flow).
--
-- 2. TL/OL direct time-edits notify the Boss. When a manager edits
--    their own clock time it's applied directly (no approval), but
--    the synthesised request still fired an "edit requested"
--    notification up the chain. Added p_silent to att_request_edit
--    and att_decide_edit so the direct-edit path can suppress both
--    the request and decision notifications. APC/IPC edit requests
--    are unchanged — their TL still gets notified.
--
-- Idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- 1. att_resume_shift — undo an accidental clock-out
-- ------------------------------------------------------------
create or replace function public.att_resume_shift()
returns public.attendance
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid       uuid := auth.uid();
  v_shift_day date := public._shift_day(now());
  v_row       public.attendance;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;

  select * into v_row from public.attendance
    where user_id = v_uid and date = v_shift_day
    for update;
  if not found then
    raise exception 'no shift to resume for today';
  end if;

  -- Already active — nothing to do (idempotent).
  if v_row.status in ('clocked-in', 'on-break') then
    return v_row;
  end if;

  -- Auto-closed shifts are not resumable here — the 11h cap fired
  -- for a reason; those go through the manager edit-request flow.
  if v_row.auto_closed then
    raise exception 'this shift was auto-closed — ask your manager to adjust it';
  end if;

  if v_row.status not in ('clocked-out', 'pending-approval') then
    raise exception 'this shift cannot be resumed (status=%)', v_row.status;
  end if;

  -- Reopen: clear the clock-out, drop any pending-approval state,
  -- reset the worked-ms cache (calcTimes recomputes live while
  -- clock_out is null), and continue from the original clock-in.
  update public.attendance
     set status         = 'clocked-in',
         clock_out      = null,
         clock_out_note = null,
         total_work_ms  = 0,
         auto_closed              = false,
         auto_closed_at           = null,
         auto_closed_acknowledged = false,
         approval_by    = null,
         approval_at    = null,
         approval_note  = null,
         requested_at   = null
   where id = v_row.id
   returning * into v_row;

  return v_row;
end;
$$;
grant execute on function public.att_resume_shift() to authenticated;

-- ------------------------------------------------------------
-- 2. att_request_edit — add p_silent (suppress manager notification)
--    Recreated from mig 057 with the extra trailing parameter.
-- ------------------------------------------------------------
drop function if exists public.att_request_edit(uuid, text, timestamptz, text);

create or replace function public.att_request_edit(
  p_attendance_id uuid,
  p_field         text,
  p_requested     timestamptz,
  p_reason        text,
  p_silent        boolean default false
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

  -- Notify the manager — unless the caller asked for silence (manager
  -- direct-edits self-approve, so there is nothing for anyone to act on).
  if not p_silent then
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
grant execute on function public.att_request_edit(uuid, text, timestamptz, text, boolean) to authenticated;

-- ------------------------------------------------------------
-- 3. att_decide_edit — add p_silent (suppress decision notification)
--    Recreated from mig 168 (break-edit aware) with the extra param.
-- ------------------------------------------------------------
drop function if exists public.att_decide_edit(uuid, boolean, text);

create or replace function public.att_decide_edit(
  p_edit_id uuid,
  p_approve boolean,
  p_note    text default null,
  p_silent  boolean default false
)
returns public.attendance_edit_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me     uuid := auth.uid();
  v_req    public.attendance_edit_requests;
  v_att    public.attendance;
  v_mgr    uuid;
  v_new_work_ms  int;
  v_new_break_ms int;
begin
  if v_me is null then raise exception 'not authenticated'; end if;

  select * into v_req from public.attendance_edit_requests where id = p_edit_id for update;
  if not found                 then raise exception 'edit request not found'; end if;
  if v_req.status <> 'pending' then raise exception 'already decided'; end if;

  select reports_to into v_mgr from public.profiles where id = v_req.user_id;
  if not (
    public.is_boss(v_me)
    or exists (select 1 from public.profiles where id = v_me and role in ('ol','developer') and is_active = true)
    or v_mgr = v_me
  ) then
    raise exception 'not authorized to decide this edit';
  end if;

  update public.attendance_edit_requests
     set status        = case when p_approve then 'approved' else 'rejected' end,
         decided_by    = v_me,
         decided_at    = now(),
         decision_note = p_note
   where id = p_edit_id
   returning * into v_req;

  if p_approve then
    select * into v_att from public.attendance where id = v_req.attendance_id for update;

    if v_req.field = 'clock_in' then
      update public.attendance
         set clock_in = v_req.requested_value
       where id = v_att.id
       returning * into v_att;
    elsif v_req.field = 'clock_out' then
      update public.attendance
         set clock_out = v_req.requested_value,
             status    = case when status = 'pending-approval' then 'clocked-out' else status end
       where id = v_att.id
       returning * into v_att;
    elsif v_req.field = 'breaks' then
      v_new_break_ms := coalesce((
        select sum(greatest(0,
          (extract(epoch from ((b->>'end')::timestamptz - (b->>'start')::timestamptz))::int) * 1000
        ))::int
          from jsonb_array_elements(v_req.requested_breaks) b
         where b->>'start' is not null and b->>'end' is not null
      ), 0);
      update public.attendance
         set breaks         = v_req.requested_breaks,
             total_break_ms = v_new_break_ms
       where id = v_att.id
       returning * into v_att;
    end if;

    if v_att.clock_in is not null and v_att.clock_out is not null then
      v_new_work_ms := greatest(0,
        extract(epoch from (v_att.clock_out - v_att.clock_in))::int * 1000
        - coalesce(v_att.total_break_ms, 0)
      );
      update public.attendance set total_work_ms = v_new_work_ms where id = v_att.id;
    end if;
  end if;

  -- Notify the requester of the decision — unless silenced (manager
  -- direct-edit: requester is the editor, so it's a self-notification).
  if not p_silent then
    perform public.emit_notification(
      v_req.user_id, v_me, 'system',
      case when p_approve then 'attendance.edit_approved' else 'attendance.edit_rejected' end,
      'Attendance edit ' || case when p_approve then 'approved' else 'rejected' end,
      'Your ' ||
        case
          when v_req.field = 'breaks' then 'break'
          else replace(v_req.field, '_', '-')
        end
        || ' edit was ' || case when p_approve then 'applied' else 'declined' end
        || coalesce(' — "' || p_note || '"', ''),
      'attendance', v_req.attendance_id, '/attendance'
    );
  end if;

  return v_req;
end;
$$;
grant execute on function public.att_decide_edit(uuid, boolean, text, boolean) to authenticated;
