-- ============================================================
-- Migration 099 — Lock over-quota approvals to the Boss
--
-- Policy: if a leave request has any unpaid_days (i.e. it exceeds
-- the requester's monthly quota), only the Boss can `approve` it.
-- Intermediate approvers (TL, OL) must `forward` instead. Reject
-- and Forward stay open to all current-level approvers.
--
-- This forces the over-quota decision (paid vs unpaid) up to the
-- person who actually owns payroll, matching v1's behavior:
-- "boss will mark it as paid or unpaid".
--
-- Implementation: re-stamp leave_decide() to check unpaid_days
-- and reject the action with a helpful error if a non-Boss tries.
-- ============================================================

create or replace function public.leave_decide(
  p_request_id uuid,
  p_action     text,
  p_note       text default null
)
returns public.leave_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req        public.leave_requests;
  v_me         uuid := auth.uid();
  v_approver   uuid;
  v_name       text;
  v_decisions  jsonb;
  v_new_level  int;
  v_is_boss    boolean;
begin
  if v_me is null then raise exception 'not authenticated'; end if;

  select * into v_req from public.leave_requests where id = p_request_id for update;
  if not found                  then raise exception 'request not found'; end if;
  if v_req.status <> 'pending'  then raise exception 'request already decided (status=%)', v_req.status; end if;

  v_approver := public.leave_current_approver(p_request_id);
  v_is_boss  := public.is_boss(v_me);

  if v_approver <> v_me and not v_is_boss then
    raise exception 'not authorized to decide this request';
  end if;

  -- Quota gate: any unpaid_days must be decided by Boss.
  -- Intermediate approvers can only forward over-quota requests.
  if p_action = 'approve'
     and coalesce(v_req.unpaid_days, 0) > 0
     and not v_is_boss then
    raise exception
      'over-quota requests must be forwarded to the Boss (this one has % unpaid day(s))',
      v_req.unpaid_days
      using errcode = 'P0001', hint = 'Use Forward instead of Approve.';
  end if;

  v_name := coalesce(public.profile_display_name(v_me), 'Someone');
  v_decisions := v_req.decisions || jsonb_build_array(jsonb_build_object(
    'level',   v_req.current_level,
    'action',  p_action,
    'by',      v_me,
    'by_name', v_name,
    'at',      to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'note',    p_note
  ));

  if p_action = 'approve' then
    update public.leave_requests
       set status        = 'approved',
           decided_by    = v_me,
           decided_at    = now(),
           decision_note = p_note,
           decisions     = v_decisions
     where id = p_request_id
     returning * into v_req;

  elsif p_action = 'reject' then
    update public.leave_requests
       set status        = 'rejected',
           decided_by    = v_me,
           decided_at    = now(),
           decision_note = p_note,
           decisions     = v_decisions
     where id = p_request_id
     returning * into v_req;

  elsif p_action = 'forward' then
    v_new_level := v_req.current_level + 1;
    if v_new_level > 3 then raise exception 'already at top of approval chain'; end if;
    update public.leave_requests
       set current_level = v_new_level,
           decisions     = v_decisions
     where id = p_request_id
     returning * into v_req;

  else
    raise exception 'invalid action: %', p_action;
  end if;

  return v_req;
end;
$$;
