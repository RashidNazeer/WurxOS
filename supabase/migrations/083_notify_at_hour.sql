-- ============================================================
-- WurxOS v2 — Migration 083: per-user notification delivery hour
--
-- Lets each user pick the local hour of day at which their daily
-- expiry notifications (campaigns + product campaigns) fire. Before
-- this migration the cron ran once at 09:00 UTC for everyone — fine
-- for some timezones, awful for others (4 AM on the US east coast).
--
-- How it works:
--   1. Add `profiles.notify_at_hour` (0-23, default 9 = 9 AM local).
--   2. Switch the unified expiry cron from `0 9 * * *` (once daily)
--      to `0 * * * *` (every hour at :00).
--   3. Inside `notify_campaign_expiries()`, before firing for a user,
--      compare `extract(hour from now() at time zone profiles.timezone)`
--      with their preferred hour. If they don't match, skip them on
--      this tick — they'll be picked up the next time their local
--      hour comes around.
--   4. The existing `campaign_notification_log` dedup table prevents
--      double-firing within the same day for the same lead-time.
-- ============================================================

alter table public.profiles
  add column if not exists notify_at_hour int not null default 9
    check (notify_at_hour >= 0 and notify_at_hour <= 23);

create or replace function public.notify_campaign_expiries()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sent     int := 0;
  v_today    date := current_date;
  v_cmp      record;
  v_pc       record;
  v_promo    jsonb;
  v_promo_id text;
  v_promo_end date;
  v_days     int;
  v_uid      uuid;
  v_prefs_days int[];
  v_recipients uuid[];
  v_title    text;
  v_body     text;
  v_brand    text;
  v_owner    uuid;
  v_pname    text;
  v_user_tz  text;
  v_user_pref_hour int;
  v_user_local_hour int;
begin
  -- Cache the per-user filter check so we only call the timezone
  -- math once per user across all campaigns/promos in this tick.
  -- Map user_id → boolean ("ok to notify right now").
  drop table if exists tmp_notify_eligible;
  create temp table tmp_notify_eligible(uid uuid primary key, ok boolean) on commit drop;

  -- --------------------------------------------------------------
  -- Campaign Tracker (brand-level shop-wide promos)
  -- --------------------------------------------------------------
  for v_cmp in
    select c.*, b.brand_name, b.owner_id as brand_owner_id
      from public.campaigns c
      join public.brands b on b.id = c.brand_id
     where c.status = 'Ongoing'
       and c.end_time is not null
       and c.end_time > now()
       and c.end_time <= now() + interval '30 days'
  loop
    v_days := greatest(0, floor(extract(epoch from (v_cmp.end_time - now())) / 86400)::int);

    select array_agg(distinct uid) into v_recipients from (
      select v_cmp.brand_owner_id as uid where v_cmp.brand_owner_id is not null
      union
      select user_id from public.brand_assignments where brand_id = v_cmp.brand_id
    ) s where uid is not null;

    if v_recipients is null then continue; end if;

    foreach v_uid in array v_recipients
    loop
      -- Per-user delivery-hour gate (cached per tick).
      if not exists (select 1 from tmp_notify_eligible where uid = v_uid) then
        select coalesce(timezone, 'UTC'), coalesce(notify_at_hour, 9)
          into v_user_tz, v_user_pref_hour
          from public.profiles where id = v_uid;
        begin
          v_user_local_hour := extract(hour from (now() at time zone v_user_tz))::int;
        exception when others then
          -- Bad timezone string in profile — fall back to UTC so the
          -- user still gets *some* notification rather than none.
          v_user_local_hour := extract(hour from (now() at time zone 'UTC'))::int;
        end;
        insert into tmp_notify_eligible(uid, ok)
          values (v_uid, v_user_local_hour = v_user_pref_hour);
      end if;
      if not (select ok from tmp_notify_eligible where uid = v_uid) then
        continue;
      end if;

      v_prefs_days := public.user_lead_days(v_uid, 'campaigns');
      if not (v_days = any(v_prefs_days)) then continue; end if;

      if exists (
        select 1 from public.campaign_notification_log
         where user_id = v_uid and entity_type = 'campaign'
           and entity_id = v_cmp.id and promo_id = '' and offset_days = v_days
      ) then continue; end if;

      v_title := case
        when v_days = 0 then 'Campaign ends today'
        when v_days = 1 then 'Campaign ends tomorrow'
        else 'Campaign ends in ' || v_days || ' days'
      end;
      v_body := coalesce(v_cmp.promotion_name, 'A campaign')
             || ' on ' || coalesce(v_cmp.brand_name, 'this brand')
             || ' ends ' || to_char(v_cmp.end_time, 'Mon DD, HH24:MI')
             || '.';

      perform public.emit_notification(
        v_uid, null, 'campaign', 'campaign.expiring_soon',
        v_title, v_body, 'campaign', v_cmp.id, '/campaigns'
      );
      insert into public.campaign_notification_log (user_id, entity_type, entity_id, promo_id, offset_days)
      values (v_uid, 'campaign', v_cmp.id, '', v_days)
      on conflict do nothing;
      v_sent := v_sent + 1;
    end loop;
  end loop;

  -- --------------------------------------------------------------
  -- Product Campaigns (per-promo)
  -- --------------------------------------------------------------
  for v_pc in
    select pc.*
      from public.product_campaigns pc
     where coalesce(jsonb_array_length(pc.promotions), 0) > 0
  loop
    select p.product_name, b.brand_name, b.owner_id
      into v_pname, v_brand, v_owner
      from public.brand_products p
      join public.brands b on b.id = p.brand_id
     where p.id = v_pc.product_id;

    select array_agg(distinct uid) into v_recipients from (
      select v_owner as uid where v_owner is not null
      union
      select user_id from public.brand_assignments where brand_id = v_pc.brand_id
    ) s where uid is not null;

    if v_recipients is null then continue; end if;

    for v_promo in select * from jsonb_array_elements(v_pc.promotions)
    loop
      v_promo_id := v_promo->>'id';
      if v_promo_id is null or v_promo_id = '' then continue; end if;

      v_promo_end := nullif(v_promo->>'end_date','')::date;
      if v_promo_end is null or v_promo_end < v_today then continue; end if;

      v_days := (v_promo_end - v_today);
      if v_days > 30 then continue; end if;

      foreach v_uid in array v_recipients
      loop
        if not exists (select 1 from tmp_notify_eligible where uid = v_uid) then
          select coalesce(timezone, 'UTC'), coalesce(notify_at_hour, 9)
            into v_user_tz, v_user_pref_hour
            from public.profiles where id = v_uid;
          begin
            v_user_local_hour := extract(hour from (now() at time zone v_user_tz))::int;
          exception when others then
            v_user_local_hour := extract(hour from (now() at time zone 'UTC'))::int;
          end;
          insert into tmp_notify_eligible(uid, ok)
            values (v_uid, v_user_local_hour = v_user_pref_hour);
        end if;
        if not (select ok from tmp_notify_eligible where uid = v_uid) then
          continue;
        end if;

        v_prefs_days := public.user_lead_days(v_uid, 'product_campaigns');
        if not (v_days = any(v_prefs_days)) then continue; end if;

        if exists (
          select 1 from public.campaign_notification_log
           where user_id = v_uid and entity_type = 'product_campaign'
             and entity_id = v_pc.id and promo_id = v_promo_id and offset_days = v_days
        ) then continue; end if;

        v_title := case
          when v_days = 0 then 'Promotion ends today'
          when v_days = 1 then 'Promotion ends tomorrow'
          else 'Promotion ends in ' || v_days || ' days'
        end;
        v_body := coalesce(v_pname, 'A product') || ' on ' || coalesce(v_brand, 'this brand')
               || ' — ' || public.label_for_promo(coalesce(v_promo->>'type','individual'))
               || case when trim(coalesce(v_promo->>'name','')) <> '' then ' "' || (v_promo->>'name') || '"' else '' end
               || ' ends ' || to_char(v_promo_end, 'Mon DD') || '.';

        perform public.emit_notification(
          v_uid, null, 'product_campaign', 'campaign.expiring_soon',
          v_title, v_body, 'product_campaign', v_pc.id, '/product-campaigns'
        );
        insert into public.campaign_notification_log (user_id, entity_type, entity_id, promo_id, offset_days)
        values (v_uid, 'product_campaign', v_pc.id, v_promo_id, v_days)
        on conflict do nothing;
        v_sent := v_sent + 1;
      end loop;
    end loop;
  end loop;

  return v_sent;
end;
$$;

-- --------------------------------------------------------------
-- Switch the cron from once-daily (09:00 UTC) to hourly. The
-- function itself filters per-user by local hour, so 24 calls/day
-- is correct — each user is processed at most once per day per
-- lead-time (deduped by campaign_notification_log).
-- --------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin perform cron.unschedule('notify-campaign-expiries');
    exception when others then null; end;
    perform cron.schedule(
      'notify-campaign-expiries',
      '0 * * * *',
      $cron$select public.notify_campaign_expiries();$cron$
    );
  end if;
end;
$$;
