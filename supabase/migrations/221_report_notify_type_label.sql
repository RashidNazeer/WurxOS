-- ============================================================
-- WurxOS v2 — Migration 221: fix report notifications for MONTHLY reports.
--
-- Bug: reports_notify_on_status() (mig 012) computed the type label as
--   case when new.type = 'biweekly' then 'Bi-Weekly' else 'Weekly' end
-- so MONTHLY reports fell into the `else` and every submit/verify/approve/
-- return notification said "Weekly report ..." even though it was a monthly
-- report. It also linked every notification to '/reports' (→ weekly page),
-- so a monthly report's notification opened the wrong page.
--
-- Fix: 3-way label (Weekly / Bi-Weekly / Monthly) and a type-aware link
-- (/weekly-reports, /biweekly-reports, /monthly-reports). Body/recipients
-- and all transition logic are otherwise IDENTICAL to mig 012.
-- ============================================================

create or replace function public.reports_notify_on_status()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_actor      uuid := auth.uid();
  v_actor_name text;
  v_brand_name text;
  v_period     text;
  v_type_label text;
  v_link       text;
  v_brand_owner uuid;
begin
  if old.status is not distinct from new.status and
     coalesce(old.reopened_at, 'epoch'::timestamptz) is not distinct from coalesce(new.reopened_at, 'epoch'::timestamptz) then
    return new;
  end if;

  select brand_name, owner_id into v_brand_name, v_brand_owner
  from public.brands where id = new.brand_id;

  v_actor_name := coalesce(public.profile_display_name(v_actor), 'Someone');
  -- 3-way type label (was 2-way; monthly wrongly read as "Weekly").
  v_type_label := case new.type
                    when 'monthly'  then 'Monthly'
                    when 'biweekly' then 'Bi-Weekly'
                    else 'Weekly'
                  end;
  v_period     := coalesce(new.period_label, to_char(new.period_start, 'YYYY-MM-DD'));
  -- Type-aware link so the notification opens the correct reports page.
  v_link       := case new.type
                    when 'monthly'  then '/monthly-reports'
                    when 'biweekly' then '/biweekly-reports'
                    else '/weekly-reports'
                  end;

  -- APC submits (draft → submitted) → notify brand owner (TL)
  if old.status = 'draft' and new.status = 'submitted' and v_brand_owner is not null then
    perform public.emit_notification(
      v_brand_owner, v_actor, 'report', 'report.submitted',
      v_type_label || ' report submitted',
      v_actor_name || ' submitted the ' || v_type_label || ' report for ' || v_brand_name || ' (' || v_period || ')',
      'report', new.id, v_link
    );
  end if;

  -- TL verifies (submitted → verified) → notify all active OLs
  if old.status = 'submitted' and new.status = 'verified' then
    perform public.emit_notification(p.id, v_actor, 'report', 'report.verified',
      v_type_label || ' report ready for approval',
      v_actor_name || ' verified the ' || v_type_label || ' report for ' || v_brand_name || ' (' || v_period || ')',
      'report', new.id, v_link)
    from public.profiles p
    where p.role = 'ol' and p.is_active = true;
  end if;

  -- OL approves (verified → approved) → notify author + brand owner (if different)
  if old.status = 'verified' and new.status = 'approved' then
    perform public.emit_notification(new.author_id, v_actor, 'report', 'report.approved',
      v_type_label || ' report approved',
      v_actor_name || ' approved your ' || v_type_label || ' report for ' || v_brand_name,
      'report', new.id, v_link);
    if v_brand_owner is not null and v_brand_owner <> new.author_id then
      perform public.emit_notification(v_brand_owner, v_actor, 'report', 'report.approved',
        v_type_label || ' report approved',
        v_actor_name || ' approved the ' || v_type_label || ' report for ' || v_brand_name,
        'report', new.id, v_link);
    end if;
  end if;

  -- Rejection / sent back: status went DOWN (approved→verified/submitted/draft,
  -- verified→submitted/draft, submitted→draft).
  if (old.status = 'approved' and new.status in ('verified','submitted','draft'))
     or (old.status = 'verified'  and new.status in ('submitted','draft'))
     or (old.status = 'submitted' and new.status = 'draft') then
    if new.status = 'draft' and new.author_id is not null then
      perform public.emit_notification(new.author_id, v_actor, 'report', 'report.returned',
        v_type_label || ' report returned for revision',
        coalesce(v_actor_name, 'Someone') || ' sent back the ' || v_type_label || ' report for ' || v_brand_name
         || case when coalesce(new.rejection_note,'') <> '' then ' — note: ' || new.rejection_note else '' end,
        'report', new.id, v_link);
    elsif new.status = 'submitted' and v_brand_owner is not null then
      perform public.emit_notification(v_brand_owner, v_actor, 'report', 'report.returned',
        v_type_label || ' report needs your review again',
        v_actor_name || ' sent back the ' || v_type_label || ' report for ' || v_brand_name
         || case when coalesce(new.rejection_note,'') <> '' then ' — note: ' || new.rejection_note else '' end,
        'report', new.id, v_link);
    end if;
  end if;

  return new;
end;
$function$;
