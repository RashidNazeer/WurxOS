-- ============================================================
-- WurxOS v2 — Migration 193: any active OL can decide TL/PCTL
-- level-1 leave requests
--
-- Background: The org has multiple OLs and TLs/PCTLs effectively
-- report to all of them (not a strict 1:1 reports_to chain). The
-- previous leave_decide enforced "caller must be the resolved
-- approver from leave_current_approver", which walks
-- profiles.reports_to once for a TL/PCTL at level 1. If that
-- column is null OR points to a different OL than the one trying
-- to approve, the RPC raises "not authorized to decide this
-- request" and the UI shows a 400.
--
-- Fix: extend leave_decide's auth check so that for a TL/PCTL
-- requester at current_level=1, ANY active OL is allowed to
-- approve / reject / forward — same authority that already
-- applies to multi-OL orgs.
--
-- APC/IPC level-1 chain is unchanged: those still report to a
-- specific TL/PCTL and the chain walk is correct for them.
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
  v_req         public.leave_requests;
  v_me          uuid := auth.uid();
  v_approver    uuid;
  v_name        text;
  v_decisions   jsonb;
  v_new_level   int;
  v_requester   public.profiles%rowtype;
  v_me_role     text;
  v_me_active   boolean := false;
  v_authorized  boolean := false;
begin
  if v_me is null then raise exception 'not authenticated'; end if;

  select * into v_req from public.leave_requests where id = p_request_id for update;
  if not found                  then raise exception 'request not found'; end if;
  if v_req.status <> 'pending'  then raise exception 'request already decided (status=%)', v_req.status; end if;

  v_approver := public.leave_current_approver(p_request_id);

  -- (1) Boss can always act
  if public.is_boss(v_me) then
    v_authorized := true;
  -- (2) The chain's resolved approver can act
  elsif v_approver = v_me then
    v_authorized := true;
  else
    -- (3) Any active OL can act on a TL/PCTL level-1 request
    select * into v_requester from public.profiles where id = v_req.requester_id;
    if found and v_req.current_level = 1 and v_requester.role in ('tl', 'pctl') then
      select role, (is_active = true and deleted_at is null)
        into v_me_role, v_me_active
        from public.profiles
       where id = v_me;
      if v_me_active and v_me_role = 'ol' then
        v_authorized := true;
      end if;
    end if;
  end if;

  if not v_authorized then
    raise exception 'not authorized to decide this request';
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

-- The leave_requests UPDATE RLS already permits public.leave_current_approver
-- and public.is_boss; for the new "any OL can act on TL/PCTL" case the RPC
-- runs SECURITY DEFINER so RLS doesn't gate the actual UPDATE — only the
-- explicit auth check inside the function matters.
