-- ============================================================
-- WurxOS v2 — Migration 194: fan out 'leave.requested' notifications
-- to every active OL when a TL/PCTL submits a leave request
--
-- The prior submit trigger (mig 055) resolved exactly one approver
-- via leave_current_approver — which walks profiles.reports_to.
-- For TLs/PCTLs in this org, reports_to is NULL across the board
-- (no 1:1 chain — every TL/PCTL effectively reports to ALL OLs).
-- The chain therefore fell back to Boss and only Boss got the
-- ping. The OLs who actually decide these requests had to manually
-- visit the leave page to see anything new.
--
-- Mig 193 already extended the AUTH gate so any active OL can
-- decide a TL/PCTL level-1 request. This migration completes that
-- by also routing the NOTIFICATION to every active OL when one
-- of them needs to act, so the right people are paged.
--
-- APC/IPC submissions are unchanged — those still resolve to the
-- requester's specific TL/PCTL via reports_to and get one
-- notification, which is the desired routing for that chain.
-- ============================================================

create or replace function public.leave_notify_on_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_requester_role text;
  v_name           text;
  v_label          text;
  v_title          text;
  v_body           text;
  v_recipient      uuid;
begin
  select role into v_requester_role
    from public.profiles
   where id = new.requester_id;

  v_name  := public.profile_display_name(new.requester_id);
  v_label := case new.type
    when 'wfh'        then 'WFH'
    when 'medical'    then 'medical leave'
    when 'emergency'  then 'emergency leave'
    when 'half_leave' then 'half-day leave'
    when 'other'      then coalesce(new.other_title, 'time off')
    else new.type
  end;
  v_title := 'New leave request';
  v_body  := v_name || ' requested ' || v_label || ' ('
    || to_char(new.start_date, 'Mon DD')
    || case when new.end_date <> new.start_date then ' – ' || to_char(new.end_date, 'Mon DD') else '' end
    || ')';

  -- TL/PCTL submissions at level 1 → fan out to ALL active OLs.
  -- Mirrors mig 193's broadened auth rule.
  if v_requester_role in ('tl', 'pctl') and new.current_level = 1 then
    for v_recipient in
      select id from public.profiles
       where role = 'ol'
         and is_active = true
         and deleted_at is null
         and id <> new.requester_id
    loop
      perform public.emit_notification(
        v_recipient, new.requester_id, 'leave', 'leave.requested',
        v_title, v_body,
        'leave', new.id, '/leave/approvals'
      );
    end loop;
    return new;
  end if;

  -- All other roles use the chain-resolved approver (APC → TL,
  -- IPC → PCTL, OL → Boss, etc.).
  v_recipient := public.leave_current_approver(new.id);
  if v_recipient is null or v_recipient = new.requester_id then return new; end if;
  perform public.emit_notification(
    v_recipient, new.requester_id, 'leave', 'leave.requested',
    v_title, v_body,
    'leave', new.id, '/leave/approvals'
  );
  return new;
end;
$$;
