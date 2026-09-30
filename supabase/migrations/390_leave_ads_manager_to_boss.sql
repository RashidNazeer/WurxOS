-- ============================================================
-- WurxOS v2 — Migration 390: Ads Manager leave goes straight to the Boss
--
-- Owner decision (2026-10). The UI has always labelled an Ads Manager's
-- request "Pending Boss" (leaveApi.mapStatusToV1), but the server walked
-- profiles.reports_to like every other role, so a manager set there was the
-- "real" approver without ever getting an Approve button. Now both agree:
-- for an ads_manager requester the approver is the Boss at every level.
--
-- Both helpers change, because both feed leave_requests RLS:
--   • leave_current_approver — leave_decide auth, the insert/forward
--     notifications (mig 194 / 055), select/update policies;
--   • leave_approver — the legacy clause still in leave_select (mig 055/102).
-- Everything else is unchanged from mig 055 / 019. Idempotent.
-- ============================================================

create or replace function public.leave_current_approver(p_request_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_req       record;
  v_cur       uuid;
  v_i         int;
  v_boss      uuid;
begin
  select requester_id, current_level, status
    into v_req
    from public.leave_requests
    where id = p_request_id;

  if not found or v_req.status <> 'pending' then return null; end if;

  select id into v_boss from public.profiles
   where role = 'boss' and is_active = true
   order by created_at asc limit 1;

  -- Ads Managers: straight to the Boss, whoever they report to.
  if exists (select 1 from public.profiles where id = v_req.requester_id and role = 'ads_manager') then
    return v_boss;
  end if;

  v_cur := v_req.requester_id;
  for v_i in 1..v_req.current_level loop
    select reports_to into v_cur from public.profiles where id = v_cur;
    if v_cur is null then
      return v_boss;  -- chain ended early, Boss is the final arbiter
    end if;
  end loop;

  -- If we climbed the full ladder and the person is the same as the
  -- requester (possible on Boss self-requests), return Boss itself.
  if v_cur = v_req.requester_id then return v_boss; end if;
  return v_cur;
end;
$$;

create or replace function public.leave_approver(uid uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select reports_to from public.profiles where id = uid and reports_to is not null and role <> 'ads_manager'),
    (select id from public.profiles where role = 'boss' and is_active = true order by created_at asc limit 1)
  );
$$;
