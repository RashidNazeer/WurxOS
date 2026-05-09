-- ============================================================
-- Migration 077 — Per-user campaign expiry notification preferences
--
-- Until now, both crons fired a single hard-coded "2 days before"
-- alert to every brand owner / assignee:
--   * 070_per_promo_expiry_notify.sql → notify_expiring_campaigns()
--     (product_campaigns, per promo, exactly 2 days before end_date)
--   * 071_campaign_tracker.sql → notify_expiring_tracker_campaigns()
--     (campaigns, once per row in a 36–60h window before end_time)
--
-- This migration lets each user decide their own lead times — e.g.
-- "remind me 7, 3, and 1 days before, for both types" — stored on
-- profiles.notification_prefs.{campaigns,product_campaigns}.lead_days.
--
-- Design:
--   * New `campaign_notification_log` table uniquely tracks
--     (user, entity, promo, offset_days) so we never re-fire the
--     same reminder twice. Promo is '' for Campaign Tracker rows
--     (they have one end_time per row).
--   * New SECURITY DEFINER function `notify_campaign_expiries()`
--     walks every active/ongoing campaign + promo, computes
--     days_left, iterates potential recipients (brand owner +
--     brand_assignments), reads their prefs, and emits if the
--     offset matches AND we haven't already logged it.
--   * Defaults if a user has no prefs: [3, 1] for both types
--     (3 days and 1 day before).
--   * pg_cron: unschedule the two old jobs and schedule the unified
--     one at 09:00 UTC daily.
-- ============================================================

-- --------------------------------------------------------------
-- 1. Log table — one row per (user, entity, promo, offset) sent
-- --------------------------------------------------------------
create table if not exists public.campaign_notification_log (
  user_id      uuid   not null references public.profiles(id) on delete cascade,
  entity_type  text   not null check (entity_type in ('campaign','product_campaign')),
  entity_id    uuid   not null,
  promo_id     text   not null default '',   -- '' for campaign-tracker rows
  offset_days  int    not null,
  sent_at      timestamptz not null default now(),
  primary key (user_id, entity_type, entity_id, promo_id, offset_days)
);

create index if not exists cnl_entity_idx on public.campaign_notification_log(entity_type, entity_id);

alter table public.campaign_notification_log enable row level security;

-- Users can see their own rows; the cron function runs as owner via
-- SECURITY DEFINER, so no write policy is needed for clients.
drop policy if exists "cnl_select_own" on public.campaign_notification_log;
create policy "cnl_select_own" on public.campaign_notification_log for select
  using (user_id = auth.uid());

-- --------------------------------------------------------------
-- 2. Helpers — read a user's lead-day array, with sane defaults
-- --------------------------------------------------------------
create or replace function public.user_lead_days(p_uid uuid, p_kind text)
returns int[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_prefs    jsonb;
  v_enabled  bool;
  v_arr      jsonb;
  v_default  int[] := array[3, 1];
begin
  select notification_prefs into v_prefs from public.profiles where id = p_uid;
  if v_prefs is null then return v_default; end if;

  -- If push flag is explicitly false, opt out entirely.
  v_enabled := coalesce((v_prefs -> p_kind ->> 'push')::bool, true);
  if v_enabled = false then return array[]::int[]; end if;

  v_arr := v_prefs -> p_kind -> 'lead_days';
  if v_arr is null or jsonb_typeof(v_arr) <> 'array' then return v_default; end if;

  return array(select (jsonb_array_elements_text(v_arr))::int);
end;
$$;

-- --------------------------------------------------------------
-- 3. Unified expiry notifier
-- --------------------------------------------------------------
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
begin
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
    -- days_left, rounded down so "ends in ~2 days" is 2
    v_days := greatest(0, floor(extract(epoch from (v_cmp.end_time - now())) / 86400)::int);

    -- Potential recipients = brand owner + current assignees
    select array_agg(distinct uid) into v_recipients from (
      select v_cmp.brand_owner_id as uid where v_cmp.brand_owner_id is not null
      union
      select user_id from public.brand_assignments where brand_id = v_cmp.brand_id
    ) s where uid is not null;

    if v_recipients is null then continue; end if;

    foreach v_uid in array v_recipients
    loop
      v_prefs_days := public.user_lead_days(v_uid, 'campaigns');
      if not (v_days = any(v_prefs_days)) then continue; end if;

      -- Dedup by the log table
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
  -- Product Campaigns (per-promo, since a row has many promos)
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
-- 4. pg_cron: unschedule old jobs, schedule the new unified one
-- --------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    -- old per-promo cron from 070
    begin perform cron.unschedule('notify-expiring-campaigns');
    exception when others then null; end;
    -- old tracker cron from 071
    begin perform cron.unschedule('notify-expiring-tracker-campaigns');
    exception when others then null; end;
    -- new unified cron — 09:00 UTC daily
    begin perform cron.unschedule('notify-campaign-expiries');
    exception when others then null; end;
    perform cron.schedule(
      'notify-campaign-expiries',
      '0 9 * * *',
      $cron$select public.notify_campaign_expiries();$cron$
    );
  end if;
end;
$$;
