-- ============================================================
-- WurxOS v2 — Migration 302: reports_remind() — an OL/Boss nudges the people
-- who owe an action on a report, WITHOUT changing its status.
--
-- The status trigger (mig 012/221) only fires on a transition, so there was no
-- way to say "you still haven't submitted / verified this". This adds a manual
-- reminder the OL fires from the Draft / Submitted stat cards:
--   * a report still in DRAFT      → remind its AUTHOR (the APC) to submit it
--   * a report still in SUBMITTED  → remind the brand's OWNER (the TL) to verify
-- Verified / approved reports need no reminder and are skipped.
--
-- One notification PER RECIPIENT (not per report) so an APC/TL with several
-- pending reports gets a single, non-spammy nudge with the count + brand list.
-- Status is re-read from the DB (the client's list can be stale), inactive /
-- deleted recipients are skipped, and the actor is never notified about their
-- own row. Generic over weekly / bi-weekly / monthly (label + link by type), so
-- the same RPC serves those pages too. Only an active OL / Boss may call it.
--
-- Idempotent.
-- ============================================================

create or replace function public.reports_remind(p_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor      uuid := auth.uid();
  v_actor_name text;
  v_sent       int := 0;
  r            record;
  v_type_label text;
  v_link       text;
  v_title      text;
  v_body       text;
  v_entity     uuid;
begin
  if not (public.is_boss(v_actor) or exists (
    select 1 from public.profiles p
    where p.id = v_actor and p.role = 'ol' and p.is_active = true
  )) then
    raise exception 'only Boss/OL can send report reminders';
  end if;

  v_actor_name := coalesce(public.profile_display_name(v_actor), 'Your Operation Lead');

  for r in
    with tgt as (
      select
        rep.id,
        rep.type,
        rep.status                                                       as kind,
        coalesce(rep.period_label, to_char(rep.period_start, 'YYYY-MM-DD')) as period,
        b.brand_name,
        case rep.status
          when 'draft'     then rep.author_id      -- APC (report author)
          when 'submitted' then b.owner_id         -- TL (brand owner)
        end                                                              as recipient
      from public.reports rep
      join public.brands b on b.id = rep.brand_id
      where rep.id = any(p_ids)
        and rep.status in ('draft', 'submitted')
    )
    select
      t.recipient,
      t.kind,
      min(t.type)                                            as type,
      count(*)                                               as n,
      (array_agg(t.brand_name order by t.brand_name))[1]     as first_brand,
      (array_agg(t.period     order by t.brand_name))[1]     as first_period,
      (array_agg(t.id         order by t.brand_name))[1]     as first_id,
      string_agg(distinct t.brand_name, ', ')                as brand_list
    from tgt t
    join public.profiles rp on rp.id = t.recipient
    where t.recipient is not null
      and t.recipient <> v_actor
      and rp.is_active = true
      and rp.deleted_at is null
    group by t.recipient, t.kind
  loop
    v_type_label := case r.type when 'monthly' then 'Monthly' when 'biweekly' then 'Bi-Weekly' else 'Weekly' end;
    v_link       := case r.type when 'monthly' then '/monthly-reports' when 'biweekly' then '/biweekly-reports' else '/weekly-reports' end;
    v_entity     := case when r.n = 1 then r.first_id else null end;   -- deep-link only when it's one report

    if r.kind = 'draft' then
      v_title := 'Reminder: submit your ' || v_type_label || ' report' || case when r.n > 1 then 's' else '' end;
      v_body  := case when r.n = 1
                   then v_actor_name || ' is waiting on your ' || v_type_label || ' report for '
                        || r.first_brand || ' (' || r.first_period || ') — it''s still a draft, please submit it.'
                   else v_actor_name || ' is waiting on ' || r.n || ' draft ' || v_type_label
                        || ' reports: ' || r.brand_list || '. Please submit them.'
                 end;
    else  -- submitted
      v_title := 'Reminder: verify a ' || v_type_label || ' report' || case when r.n > 1 then 's' else '' end;
      v_body  := case when r.n = 1
                   then 'The ' || v_type_label || ' report for ' || r.first_brand || ' (' || r.first_period
                        || ') is submitted and awaiting your verification.'
                   else r.n || ' ' || v_type_label || ' reports are awaiting your verification: ' || r.brand_list || '.'
                 end;
    end if;

    perform public.emit_notification(
      r.recipient, v_actor, 'report', 'report.reminder',
      v_title, v_body, 'report', v_entity, v_link
    );
    v_sent := v_sent + 1;
  end loop;

  return jsonb_build_object('sent', v_sent);
end;
$$;

revoke all on function public.reports_remind(uuid[]) from public, anon;
grant execute on function public.reports_remind(uuid[]) to authenticated, service_role;
