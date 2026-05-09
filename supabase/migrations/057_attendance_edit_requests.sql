-- ============================================================
-- Migration 057 — Attendance edit-requests + clock-out note
--
-- Adds:
--   attendance.clock_out_note     text   (APC summary at request time)
--   attendance_edit_requests      table  (employee requests to correct
--                                         a recorded clock-in or
--                                         clock-out time; approver
--                                         applies it on approve)
--   RPCs:
--     att_request_clock_out(note)        — extended to accept a note
--     att_request_edit(id, field, val, reason) — employee submits edit
--     att_decide_edit(id, approve, note) — manager applies/rejects
-- ============================================================

-- --------------------------------------------------------------
-- 1. Clock-out note column + extended RPC
-- --------------------------------------------------------------
alter table public.attendance
  add column if not exists clock_out_note text;

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
    where user_id = v_uid and date = current_date
    for update;

  if not found then raise exception 'no active shift to clock out from'; end if;
  if v_row.status in ('clocked-out','pending-approval') then
    return v_row;  -- idempotent; see migration 054's guard
  end if;

  select role into v_role from public.profiles where id = v_uid;
  v_new_status := case when v_role in ('apc','ipc') then 'pending-approval' else 'clocked-out' end;

  update public.attendance
     set status          = v_new_status,
         clock_out_note  = coalesce(p_note, clock_out_note),
         clock_out       = case when v_new_status = 'clocked-out' then v_end else clock_out end,
         total_work_ms   = case when v_new_status = 'clocked-out'
                                then greatest(0, extract(epoch from (v_end - clock_in))::int * 1000
                                     - coalesce(total_break_ms, 0))
                                else total_work_ms end
   where id = v_row.id
   returning * into v_row;
  return v_row;
end;
$$;
grant execute on function public.att_request_clock_out(text) to authenticated;

-- Keep the no-arg signature working (callers upgrade gradually).
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
-- 2. Edit-requests table
-- --------------------------------------------------------------
create table if not exists public.attendance_edit_requests (
  id               uuid primary key default gen_random_uuid(),
  attendance_id    uuid not null references public.attendance(id) on delete cascade,
  user_id          uuid not null references public.profiles(id) on delete cascade,
  field            text not null check (field in ('clock_in','clock_out')),
  requested_value  timestamptz not null,
  reason           text not null default '',
  status           text not null default 'pending'
                     check (status in ('pending','approved','rejected')),
  decided_by       uuid references public.profiles(id) on delete set null,
  decided_at       timestamptz,
  decision_note    text,
  created_at       timestamptz not null default now()
);

create index if not exists attendance_edit_user_idx    on public.attendance_edit_requests(user_id, created_at desc);
create index if not exists attendance_edit_status_idx  on public.attendance_edit_requests(status);
create index if not exists attendance_edit_attendance_idx on public.attendance_edit_requests(attendance_id);

alter table public.attendance_edit_requests enable row level security;

-- The requester, approver (manager of requester), Boss, OL, and devs can read.
drop policy if exists "attedit_select" on public.attendance_edit_requests;
create policy "attedit_select"
  on public.attendance_edit_requests for select
  using (
    auth.uid() = user_id
    or public.is_boss(auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true
    )
    or exists (
      select 1 from public.profiles p
      where p.id = attendance_edit_requests.user_id and p.reports_to = auth.uid()
    )
  );

-- Requester inserts pending requests for their own rows.
drop policy if exists "attedit_insert_self" on public.attendance_edit_requests;
create policy "attedit_insert_self"
  on public.attendance_edit_requests for insert
  with check (auth.uid() = user_id and status = 'pending');

-- Only the decision RPC mutates status; we allow approvers/Boss to update
-- so the RPC (SECURITY DEFINER) always works, but direct UPDATEs are
-- narrowed by the RPC's logic itself.
drop policy if exists "attedit_update" on public.attendance_edit_requests;
create policy "attedit_update"
  on public.attendance_edit_requests for update
  using (
    public.is_boss(auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true
    )
    or exists (
      select 1 from public.profiles p
      where p.id = attendance_edit_requests.user_id and p.reports_to = auth.uid()
    )
  );

-- --------------------------------------------------------------
-- 3. Submit an edit request (employee)
-- --------------------------------------------------------------
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
begin
  if v_me is null then raise exception 'not authenticated'; end if;
  if p_field not in ('clock_in','clock_out') then raise exception 'bad field'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'reason required'; end if;

  select * into v_att from public.attendance where id = p_attendance_id;
  if not found                 then raise exception 'attendance row not found'; end if;
  if v_att.user_id <> v_me     then raise exception 'can only edit your own attendance'; end if;

  -- Disallow if there's already a pending request for the same field
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

  -- Notify the manager (reports_to or Boss fallback)
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

  return v_row;
end;
$$;
grant execute on function public.att_request_edit(uuid, text, timestamptz, text) to authenticated;

-- --------------------------------------------------------------
-- 4. Decide an edit request (manager/Boss)
--    On approve: update the attendance row's clock_in or clock_out
--    to the requested value, recompute total_work_ms if affected.
-- --------------------------------------------------------------
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
  v_new_work_ms int;
begin
  if v_me is null then raise exception 'not authenticated'; end if;

  select * into v_req from public.attendance_edit_requests where id = p_edit_id for update;
  if not found                 then raise exception 'edit request not found'; end if;
  if v_req.status <> 'pending' then raise exception 'already decided'; end if;

  -- Authorization: Boss, OL/developer, or the requester's reports_to
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
    else
      update public.attendance
         set clock_out = v_req.requested_value,
             status    = case when status = 'pending-approval' then 'clocked-out' else status end
       where id = v_att.id
       returning * into v_att;
    end if;

    -- Recompute total_work_ms if the shift is fully closed now
    if v_att.clock_in is not null and v_att.clock_out is not null then
      v_new_work_ms := greatest(0,
        extract(epoch from (v_att.clock_out - v_att.clock_in))::int * 1000
        - coalesce(v_att.total_break_ms, 0)
      );
      update public.attendance set total_work_ms = v_new_work_ms where id = v_att.id;
    end if;
  end if;

  -- Notify requester of the decision
  perform public.emit_notification(
    v_req.user_id, v_me, 'system',
    case when p_approve then 'attendance.edit_approved' else 'attendance.edit_rejected' end,
    'Attendance edit ' || case when p_approve then 'approved' else 'rejected' end,
    'Your ' || replace(v_req.field, '_', '-') || ' edit was ' ||
      case when p_approve then 'applied' else 'declined' end ||
      coalesce(' — "' || p_note || '"', ''),
    'attendance', v_req.attendance_id, '/attendance'
  );

  return v_req;
end;
$$;
grant execute on function public.att_decide_edit(uuid, boolean, text) to authenticated;
