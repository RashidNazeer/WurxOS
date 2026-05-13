-- ============================================================
-- WurxOS v2 — Migration 169: APC leave skips OL on forward
--
-- Before: TL forwards an APC's leave -> current_level bumps from 1
--   to 2, putting the OL on the hook. The UI labelled it
--   "Pending OL" and OL got Approve/Reject buttons, which contradicted
--   the "Forwarded to Boss" hint already shown alongside the status.
--
-- After (per user 2026-05-14): an APC/IPC leave goes
--   APC -> TL -> Boss. OL is not in the chain. TL can approve, reject,
--   or forward; forward jumps current_level directly to 3 (Boss).
--   OL can still SEE the request (read RLS unchanged) — they just
--   can't decide it.
--
-- Implementation:
--   1. Patch leave_decide so action='forward' from level 1, when the
--      requester is APC or IPC, sets new_level to 3 (not 2).
--   2. Backfill: every pending APC/IPC leave currently parked at
--      level 2 gets moved to level 3 so it shows as "Pending Boss"
--      immediately on next page load.
--
-- Idempotent.
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
  v_role       text;
begin
  if v_me is null then raise exception 'not authenticated'; end if;

  select * into v_req from public.leave_requests where id = p_request_id for update;
  if not found                  then raise exception 'request not found'; end if;
  if v_req.status <> 'pending'  then raise exception 'request already decided (status=%)', v_req.status; end if;

  v_approver := public.leave_current_approver(p_request_id);
  if v_approver <> v_me and not public.is_boss(v_me) then
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
    -- Look up requester role so APC/IPC at level 1 can skip OL.
    select role into v_role from public.profiles where id = v_req.requester_id;
    if v_req.current_level = 1 and v_role in ('apc', 'ipc') then
      v_new_level := 3;
    else
      v_new_level := v_req.current_level + 1;
    end if;
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
grant execute on function public.leave_decide(uuid, text, text) to authenticated;

-- Backfill: any pending APC/IPC leave currently at level 2 was put
-- there by the old logic. Move them to level 3 so the right person
-- (Boss) is the active approver.
do $$
declare
  v_moved int;
begin
  with bumped as (
    update public.leave_requests lr
       set current_level = 3
      from public.profiles p
     where lr.requester_id = p.id
       and lr.status = 'pending'
       and lr.current_level = 2
       and p.role in ('apc', 'ipc')
    returning lr.id
  )
  select count(*) into v_moved from bumped;
  raise notice '[mig 169] bumped % APC/IPC pending leaves from level 2 to level 3', v_moved;
end;
$$;
