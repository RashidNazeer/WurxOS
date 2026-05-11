-- ============================================================
-- WurxOS v2 — Migration 153: diagnostics on leave_decide
--
-- The user is hitting "not authorized to decide this request" again
-- even after mig 151's role-based authorization fallback. We need
-- proof of what auth.uid() and the request state actually look like
-- at the moment of the call, since the client-side logging only
-- shows what was DISPATCHED, not how the server saw it.
--
-- This migration re-stamps leave_decide() with RAISE NOTICE statements
-- at every branch. The notices land in the Postgres log (visible in
-- the Supabase dashboard → Database → Logs) so we can reconstruct the
-- exact decision path the function took.
--
-- IMPORTANT: this migration preserves the mig-151 authorization
-- logic — same gates, same outcomes. Only adds NOTICE statements.
--
-- Idempotent. Remove the NOTICE lines once the bug is reproduced.
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
  v_req            public.leave_requests;
  v_me             uuid := auth.uid();
  v_my_role        text;
  v_requester_role text;
  v_chain_approver uuid;
  v_name           text;
  v_decisions      jsonb;
  v_new_level      int;
  v_is_boss        boolean;
  v_allowed        boolean := false;
  v_reason         text := 'none';
begin
  raise notice '[leave_decide] entry: me=% action=% req=%', v_me, p_action, p_request_id;

  if v_me is null then raise exception 'not authenticated'; end if;

  select * into v_req from public.leave_requests where id = p_request_id for update;
  if not found then raise exception 'request not found'; end if;
  raise notice '[leave_decide] req loaded: status=% level=% requester=%',
    v_req.status, v_req.current_level, v_req.requester_id;

  if v_req.status <> 'pending' then
    raise exception 'request already decided (status=%)', v_req.status;
  end if;

  v_chain_approver := public.leave_current_approver(p_request_id);
  v_is_boss        := public.is_boss(v_me);
  raise notice '[leave_decide] chain_approver=% is_boss=%', v_chain_approver, v_is_boss;

  select role into v_my_role        from public.profiles where id = v_me           and is_active = true;
  select role into v_requester_role from public.profiles where id = v_req.requester_id;
  raise notice '[leave_decide] my_role=% requester_role=%', v_my_role, v_requester_role;

  if v_is_boss then
    v_allowed := true;
    v_reason := 'boss';
  elsif v_chain_approver = v_me then
    v_allowed := true;
    v_reason := 'literal chain match';
  elsif v_my_role is not null then
    if v_req.current_level = 1 then
      if v_requester_role in ('apc', 'ipc') and v_my_role in ('tl', 'pctl') then
        v_allowed := true; v_reason := 'role-based: tl/pctl over apc/ipc at L1';
      elsif v_requester_role in ('tl', 'pctl') and v_my_role = 'ol' then
        v_allowed := true; v_reason := 'role-based: ol over tl/pctl at L1';
      end if;
    elsif v_req.current_level = 2 then
      if v_requester_role in ('apc', 'ipc') and v_my_role = 'ol' then
        v_allowed := true; v_reason := 'role-based: ol over apc/ipc at L2';
      end if;
    end if;
  end if;

  raise notice '[leave_decide] authorization: allowed=% via=%', v_allowed, v_reason;

  if not v_allowed then
    raise exception 'not authorized to decide this request (me=%, role=%, requester_role=%, level=%, chain_approver=%)',
      v_me, v_my_role, v_requester_role, v_req.current_level, v_chain_approver;
  end if;

  -- Quota gate: any unpaid_days must be decided by Boss.
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
  raise notice '[leave_decide] applying action: %', p_action;

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

  raise notice '[leave_decide] done: new status=% new level=%', v_req.status, v_req.current_level;
  return v_req;
end;
$$;
