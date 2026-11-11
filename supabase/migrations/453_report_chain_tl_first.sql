-- ============================================================
-- WurxOS v2 — Migration 453: a report goes APC -> TL (verifies) -> OL (approves). Nothing skips a stage.
--
-- Until now only the UI enforced the order. The OL's "Verify as TL" button moved a submitted report to
-- verified without the Team Lead (26 times in Sep-Oct), and nothing in the database stopped any other
-- caller from jumping a stage either. Now, for every signed-in user:
--   * only the Team Lead (or the Boss, as the backup) can move submitted -> verified; an OL cannot;
--   * a report cannot skip ahead: draft -> verified/approved and submitted -> approved are refused.
-- Moving DOWN (returns, reopen) is unchanged, and calls with no signed-in user (admin scripts) pass.
--
-- Also: a report CREATED already as 'submitted' never told the Team Lead, because the notify trigger only
-- fires on UPDATE. A small AFTER INSERT trigger now sends the same "report submitted" notification.
-- Idempotent.
-- ============================================================

create or replace function public.reports_guard_status_flow()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role text;
begin
  if new.status is not distinct from old.status or auth.uid() is null then
    return new;
  end if;
  select role into v_role from public.profiles where id = auth.uid();
  if v_role = 'developer' then
    return new;
  end if;

  if old.status = 'submitted' and new.status = 'verified' and v_role = 'ol' then
    raise exception 'A report must be verified by the Team Lead first; the OL approves it afterwards.'
      using errcode = '42501';
  end if;
  if (old.status = 'draft' and new.status in ('verified', 'approved'))
     or (old.status = 'submitted' and new.status = 'approved') then
    raise exception 'A report cannot skip a stage: it goes APC -> Team Lead verifies -> OL approves.'
      using errcode = '42501';
  end if;
  return new;
end;
$function$;

drop trigger if exists reports_guard_status_flow_trg on public.reports;
create trigger reports_guard_status_flow_trg
  before update of status on public.reports
  for each row execute function public.reports_guard_status_flow();

create or replace function public.reports_notify_on_insert()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_actor      uuid := auth.uid();
  v_brand_name text;
  v_brand_owner uuid;
  v_type_label text;
  v_link       text;
begin
  if new.status is distinct from 'submitted' then
    return new;
  end if;
  select brand_name, owner_id into v_brand_name, v_brand_owner from public.brands where id = new.brand_id;
  if v_brand_owner is null then
    return new;
  end if;
  v_type_label := case new.type when 'monthly' then 'Monthly' when 'biweekly' then 'Bi-Weekly' else 'Weekly' end;
  v_link       := case new.type when 'monthly' then '/monthly-reports' when 'biweekly' then '/biweekly-reports' else '/weekly-reports' end;
  perform public.emit_notification(
    v_brand_owner, v_actor, 'report', 'report.submitted',
    v_type_label || ' report submitted',
    coalesce(public.profile_display_name(v_actor), 'Someone') || ' submitted the ' || v_type_label || ' report for '
      || v_brand_name || ' (' || coalesce(new.period_label, to_char(new.period_start, 'YYYY-MM-DD')) || ')',
    'report', new.id, v_link
  );
  return new;
end;
$function$;

drop trigger if exists reports_notify_ai on public.reports;
create trigger reports_notify_ai
  after insert on public.reports
  for each row execute function public.reports_notify_on_insert();
