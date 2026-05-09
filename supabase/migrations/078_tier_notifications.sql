-- ============================================================
-- Migration 078 — Tier Notifications
--
-- Port of v1's "Tier Tracker" reminder system. Each user with
-- brand responsibility picks two day-of-month + time slots each
-- month (default 25th @ 09:00 and 30th @ 18:00). When the clock
-- passes a slot, we compute which of THEIR brands are "under
-- tier" (tier present and not 'unlimited') and emit a single
-- consolidated notification listing them.
--
-- Per-user filtering by role (matches v1):
--   boss / ol                → all active brands with concrete tier
--   tl / pctl                → brands they own (owner_id = uid)
--   apc / ipc                → brands assigned via brand_assignments
--
-- Schedule: pg_cron every 5 minutes. The function is a no-op for
-- users whose slots haven't hit or whose slots have already fired
-- this month (tracked in tier_notification_log).
--
-- Settings shape on profiles.notification_prefs.tier:
--   {
--     enabled: true,
--     day1: 25, time1: '09:00',
--     day2: 30, time2: '18:00'
--   }
-- ============================================================

-- --------------------------------------------------------------
-- 1. Per-slot, per-month, per-user fire log
-- --------------------------------------------------------------
create table if not exists public.tier_notification_log (
  user_id   uuid not null references public.profiles(id) on delete cascade,
  year      int  not null,
  month     int  not null check (month between 1 and 12),
  slot_idx  int  not null check (slot_idx in (1, 2)),
  fired_at  timestamptz not null default now(),
  brand_count int not null default 0,
  primary key (user_id, year, month, slot_idx)
);

alter table public.tier_notification_log enable row level security;

drop policy if exists "tnl_select_own" on public.tier_notification_log;
create policy "tnl_select_own" on public.tier_notification_log for select
  using (user_id = auth.uid());

-- --------------------------------------------------------------
-- 2. Tier settings reader with defaults
-- --------------------------------------------------------------
create or replace function public.user_tier_prefs(p_uid uuid)
returns table (
  enabled bool,
  day1    int,
  time1   text,
  day2    int,
  time2   text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v jsonb;
begin
  select notification_prefs -> 'tier' into v from public.profiles where id = p_uid;
  -- Sensible defaults matching v1: 25th @ 09:00 + 30th @ 18:00
  enabled := coalesce((v ->> 'enabled')::bool, true);
  day1    := coalesce(nullif(v ->> 'day1', '')::int, 25);
  time1   := coalesce(nullif(v ->> 'time1', ''), '09:00');
  day2    := coalesce(nullif(v ->> 'day2', '')::int, 30);
  time2   := coalesce(nullif(v ->> 'time2', ''), '18:00');
  return next;
end;
$$;

-- --------------------------------------------------------------
-- 3. "Under tier" brand collector per user (role-scoped)
-- --------------------------------------------------------------
-- A brand is "under tier" for this reminder iff:
--   * status = 'active'
--   * tier is not null, not empty, not 'unlimited' (case-insensitive)
-- The caller (cron function) then scopes by the user's role.
create or replace function public.brands_under_tier_for(p_uid uuid)
returns table (id uuid, brand_name text, tier text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  select role into v_role from public.profiles where id = p_uid and is_active = true;
  if v_role is null then return; end if;

  if v_role in ('boss', 'ol', 'developer') then
    return query
      select b.id, b.brand_name, b.tier
        from public.brands b
       where b.status = 'active'
         and b.tier is not null
         and trim(b.tier) <> ''
         and lower(b.tier) <> 'unlimited'
       order by b.brand_name;
  elsif v_role in ('tl', 'pctl') then
    return query
      select b.id, b.brand_name, b.tier
        from public.brands b
       where b.status = 'active'
         and b.owner_id = p_uid
         and b.tier is not null
         and trim(b.tier) <> ''
         and lower(b.tier) <> 'unlimited'
       order by b.brand_name;
  elsif v_role in ('apc', 'ipc') then
    return query
      select b.id, b.brand_name, b.tier
        from public.brands b
        join public.brand_assignments ba on ba.brand_id = b.id
       where ba.user_id = p_uid
         and b.status = 'active'
         and b.tier is not null
         and trim(b.tier) <> ''
         and lower(b.tier) <> 'unlimited'
       order by b.brand_name;
  end if;
end;
$$;

-- --------------------------------------------------------------
-- 4. Unified cron function — called every 5 minutes
-- --------------------------------------------------------------
-- For each active user with brand responsibility:
--   * Read their tier prefs (defaults applied by user_tier_prefs)
--   * For each of 2 slots: check if today is the effective day AND
--     the slot's HH:MM has already passed AND we haven't logged a
--     fire for (user, year, month, slot_idx)
--   * Pull their under-tier brand list; if non-empty, emit once
--     with a summary body + deep-link to /brands
--   * Log the fire regardless (including empty) so we don't recheck
--     this slot again this month
create or replace function public.notify_tier_reminders()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now        timestamptz := now();
  v_today      date := current_date;
  v_year       int  := extract(year  from v_today)::int;
  v_month      int  := extract(month from v_today)::int;
  v_last_day   int  := extract(day from (date_trunc('month', v_today) + interval '1 month - 1 day'))::int;
  v_user       record;
  v_prefs      record;
  v_slot       int;
  v_day        int;
  v_time_txt   text;
  v_eff_day    int;
  v_slot_ts    timestamptz;
  v_brands     record;
  v_list       text;
  v_count      int;
  v_sent       int := 0;
  v_title      text;
  v_body       text;
  v_preview    text;
  v_extra      text;
  v_idx        int;
  v_days_left  int;
begin
  -- Iterate every active user that can own brand responsibility.
  -- Developer is excluded (they have no brand load in v2, per menu spec).
  for v_user in
    select id, role
      from public.profiles
     where is_active = true
       and role in ('boss','ol','tl','pctl','apc','ipc')
  loop
    select * into v_prefs from public.user_tier_prefs(v_user.id);
    if not v_prefs.enabled then continue; end if;

    for v_slot in 1..2 loop
      v_day     := case when v_slot = 1 then v_prefs.day1 else v_prefs.day2 end;
      v_time_txt := case when v_slot = 1 then v_prefs.time1 else v_prefs.time2 end;

      -- Fallback if the user picked e.g. day 31 in February
      v_eff_day := least(v_day, v_last_day);

      if extract(day from v_today)::int <> v_eff_day then continue; end if;

      begin
        v_slot_ts := (v_today::text || ' ' || v_time_txt)::timestamp;
      exception when others then
        continue;   -- malformed time string — skip gracefully
      end;

      if v_now < v_slot_ts then continue; end if;

      if exists (
        select 1 from public.tier_notification_log
         where user_id = v_user.id
           and year = v_year and month = v_month and slot_idx = v_slot
      ) then continue; end if;

      -- Collect brands under tier for this user
      v_list := ''; v_count := 0; v_preview := ''; v_extra := '';
      v_idx := 0;
      for v_brands in select * from public.brands_under_tier_for(v_user.id)
      loop
        v_count := v_count + 1;
        if v_idx < 3 then
          if v_preview <> '' then v_preview := v_preview || ', '; end if;
          v_preview := v_preview || v_brands.brand_name || ' (' || v_brands.tier || ')';
        end if;
        v_idx := v_idx + 1;
      end loop;

      if v_count = 0 then
        -- Still log the slot so we don't recheck until next month
        insert into public.tier_notification_log (user_id, year, month, slot_idx, brand_count)
        values (v_user.id, v_year, v_month, v_slot, 0)
        on conflict do nothing;
        continue;
      end if;

      if v_count > 3 then
        v_extra := ' +' || (v_count - 3) || ' more';
      end if;

      v_days_left := v_last_day - extract(day from v_today)::int;
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
      values (v_user.id, v_year, v_month, v_slot, v_count)
      on conflict do nothing;
      v_sent := v_sent + 1;
    end loop;
  end loop;

  return v_sent;
end;
$$;

-- --------------------------------------------------------------
-- 5. pg_cron schedule — every 5 minutes
-- --------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin perform cron.unschedule('notify-tier-reminders');
    exception when others then null; end;
    perform cron.schedule(
      'notify-tier-reminders',
      '*/5 * * * *',
      $cron$select public.notify_tier_reminders();$cron$
    );
  end if;
end;
$$;
