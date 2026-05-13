-- ============================================================
-- WurxOS v2 — Migration 168: APC break-edit requests
--
-- Extends the attendance_edit_requests flow (mig 057) so APCs/IPCs
-- can request to correct their break entries. Same approval shape
-- as clock_in / clock_out edits — TL (or Boss/OL/dev) approves;
-- on approve, the attendance row's `breaks` jsonb is replaced and
-- total_break_ms / total_work_ms are recomputed.
--
-- Schema delta:
--   * field CHECK now allows 'breaks'.
--   * requested_value dropped to nullable (a breaks edit doesn't
--     carry a single timestamp).
--   * requested_breaks jsonb column carries the full new array.
--
-- New RPC: att_request_break_edit(attendance_id, breaks_jsonb, reason)
-- Extended RPC: att_decide_edit branches on field='breaks' and
--   recomputes total_break_ms from the new array.
--
-- Idempotent.
-- ============================================================

-- 1. Schema delta
alter table public.attendance_edit_requests
  alter column requested_value drop not null;

alter table public.attendance_edit_requests
  drop constraint if exists attendance_edit_requests_field_check;
alter table public.attendance_edit_requests
  add constraint attendance_edit_requests_field_check
    check (field in ('clock_in', 'clock_out', 'breaks'));

alter table public.attendance_edit_requests
  add column if not exists requested_breaks jsonb;

-- 2. New RPC — request a break edit
create or replace function public.att_request_break_edit(
  p_attendance_id uuid,
  p_breaks        jsonb,
  p_reason        text
)
returns public.attendance_edit_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me  uuid := auth.uid();
  v_att public.attendance;
  v_row public.attendance_edit_requests;
  v_mgr uuid;
  v_name text;
begin
  if v_me is null then raise exception 'not authenticated'; end if;
  if p_breaks is null or jsonb_typeof(p_breaks) <> 'array' then
    raise exception 'breaks must be a jsonb array';
  end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'reason required'; end if;

  select * into v_att from public.attendance where id = p_attendance_id;
  if not found            then raise exception 'attendance row not found'; end if;
  if v_att.user_id <> v_me then raise exception 'can only edit your own attendance'; end if;

  if exists (
    select 1 from public.attendance_edit_requests
     where attendance_id = p_attendance_id and field = 'breaks' and status = 'pending'
  ) then
    raise exception 'a pending break edit request already exists';
  end if;

  insert into public.attendance_edit_requests
    (attendance_id, user_id, field, requested_breaks, reason)
    values (p_attendance_id, v_me, 'breaks', p_breaks, trim(p_reason))
    returning * into v_row;

  -- Notify the requester's TL (or Boss as fallback).
  select coalesce(reports_to, (
    select id from public.profiles where role = 'boss' and is_active = true
    order by created_at asc limit 1
  )) into v_mgr
    from public.profiles where id = v_me;
  v_name := coalesce(public.profile_display_name(v_me), 'Someone');
  if v_mgr is not null and v_mgr <> v_me then
    perform public.emit_notification(
      v_mgr, v_me, 'system', 'attendance.edit_requested',
      'Break edit request',
      v_name || ' requested an edit to their break times.',
      'attendance', p_attendance_id, '/attendance'
    );
  end if;

  return v_row;
end;
$$;
grant execute on function public.att_request_break_edit(uuid, jsonb, text) to authenticated;

-- 3. Extend att_decide_edit to handle field='breaks'.
--    Existing signature preserved — CREATE OR REPLACE just swaps the body.
create or replace function public.att_decide_edit(
  p_edit_id uuid,
  p_approve boolean,
  p_note    text default null
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

  -- Authorization: Boss, OL/developer, or the requester's reports_to.
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
      -- Re-derive total_break_ms from the new array. Each break entry is
      -- {"start": tstz, "end": tstz}; only closed entries contribute.
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

    -- Recompute total_work_ms if the shift is fully closed now.
    if v_att.clock_in is not null and v_att.clock_out is not null then
      v_new_work_ms := greatest(0,
        extract(epoch from (v_att.clock_out - v_att.clock_in))::int * 1000
        - coalesce(v_att.total_break_ms, 0)
      );
      update public.attendance set total_work_ms = v_new_work_ms where id = v_att.id;
    end if;
  end if;

  -- Notify the requester of the decision.
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

  return v_req;
end;
$$;
grant execute on function public.att_decide_edit(uuid, boolean, text) to authenticated;
