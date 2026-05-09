-- ============================================================
-- Migration 092 — Tier notifications: honour user timezone
--
-- Migration 078 computed the slot timestamp by concatenating
-- current_date with the saved HH:MM string and casting to a
-- naive `timestamp`, which Postgres then promotes to timestamptz
-- in the SERVER timezone (UTC on Supabase). Result: a user in
-- Karachi who picks "16:23" gets reminded at 16:23 UTC = 21:23
-- PKT — five hours late.
--
-- Fix: read profiles.timezone and build the slot moment as
-- `<date> <time> at time zone <tz>`, which yields a real
-- timestamptz anchored to the user's local clock.
-- ============================================================

create or replace function public.notify_tier_reminders()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now        timestamptz := now();
  v_user       record;
  v_prefs      record;
  v_slot       int;
  v_day        int;
  v_time_txt   text;
  v_tz         text;
  v_user_now   timestamp;       -- user's local "wall clock" right now
  v_user_today date;
  v_user_year  int;
  v_user_month int;
  v_user_dom   int;
  v_user_last_day int;
  v_eff_day    int;
  v_slot_ts    timestamptz;
  v_brands     record;
  v_count      int;
  v_idx        int;
  v_preview    text;
  v_extra      text;
  v_days_left  int;
  v_title      text;
  v_body       text;
  v_sent       int := 0;
begin
  for v_user in
    select id, role, coalesce(timezone, 'UTC') as tz
      from public.profiles
     where is_active = true
       and role in ('boss','ol','tl','pctl','apc','ipc')
  loop
    v_tz := v_user.tz;
    -- Today / month / last-day computed in the USER's local zone.
    v_user_now      := (v_now at time zone v_tz);
    v_user_today    := v_user_now::date;
    v_user_year     := extract(year  from v_user_today)::int;
    v_user_month    := extract(month from v_user_today)::int;
    v_user_dom      := extract(day   from v_user_today)::int;
    v_user_last_day := extract(day from (date_trunc('month', v_user_today::timestamp) + interval '1 month - 1 day'))::int;

    select * into v_prefs from public.user_tier_prefs(v_user.id);
    if not v_prefs.enabled then continue; end if;

    for v_slot in 1..2 loop
      v_day      := case when v_slot = 1 then v_prefs.day1  else v_prefs.day2  end;
      v_time_txt := case when v_slot = 1 then v_prefs.time1 else v_prefs.time2 end;
      v_eff_day  := least(v_day, v_user_last_day);

      if v_user_dom <> v_eff_day then continue; end if;

      begin
        -- Build the slot moment as `<local-date> <HH:MM>` then anchor it
        -- to the user's timezone, producing a real timestamptz.
        v_slot_ts := ((v_user_today::text || ' ' || v_time_txt)::timestamp
                      at time zone v_tz);
      exception when others then
        continue;
      end;

      if v_now < v_slot_ts then continue; end if;

      if exists (
        select 1 from public.tier_notification_log
         where user_id = v_user.id
           and year = v_user_year and month = v_user_month and slot_idx = v_slot
      ) then continue; end if;

      v_count := 0; v_idx := 0; v_preview := ''; v_extra := '';
      for v_brands in select * from public.brands_under_tier_for(v_user.id)
      loop
        v_count := v_count + 1;
        if v_idx < 3 then
          if v_preview <> '' then v_preview := v_preview || ', '; end if;
          v_preview := v_preview || v_brands.brand_name || ' (' || v_brands.brand_tier || ')';
        end if;
        v_idx := v_idx + 1;
      end loop;

      if v_count = 0 then
        insert into public.tier_notification_log (user_id, year, month, slot_idx, brand_count)
        values (v_user.id, v_user_year, v_user_month, v_slot, 0)
        on conflict do nothing;
        continue;
      end if;

      if v_count > 3 then v_extra := ' +' || (v_count - 3) || ' more'; end if;

      v_days_left := v_user_last_day - v_user_dom;
      if v_days_left <= 1 then
        v_title := 'Month ending — generate tier sales';
      else
        v_title := 'Tier reminder: ' || v_days_left || ' day' ||
                   case when v_days_left = 1 then '' else 's' end || ' left';
      end if;

      v_body := v_count || ' brand' || case when v_count = 1 then '' else 's' end
             || ' need sale generation — ' || v_preview || v_extra;

      perform public.emit_notification(
        v_user.id, null, 'tier', 'tier.reminder',
        v_title, v_body, 'tier_reminder', null, '/brands'
      );

      insert into public.tier_notification_log (user_id, year, month, slot_idx, brand_count)
      values (v_user.id, v_user_year, v_user_month, v_slot, v_count)
      on conflict do nothing;

      v_sent := v_sent + 1;
    end loop;
  end loop;

  return v_sent;
end;
$$;
