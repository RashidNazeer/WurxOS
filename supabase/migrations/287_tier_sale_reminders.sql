-- ============================================================
-- 287 — Tier sale reminders: per-brand, date-driven (replaces the monthly digest).
--
-- Old flow (mig 078): each user picked two day-of-month slots; on those days a
-- SINGLE notification listed ALL their under-tier brands. New flow: a brand that
-- isn't 'unlimited' must have a sale generated at least every 30 DAYS to keep its
-- creator-outreach tier unlocked. Users record the LAST date a sale was generated
-- per brand; we then remind — PER BRAND — 3/2/1 days before (last_sale + 30d) and
-- then DAILY until they act (update the date → clock resets, or set tier =
-- 'unlimited' → brand drops out of the set). Eligibility depends ONLY on `tier`
-- (not 'unlimited') — GMV is irrelevant.
-- ============================================================

-- 1. The recorded date (was missing).
alter table public.brands
  add column if not exists last_sale_generated_date date;

-- 2. Setter — the Brand edit form is Boss/OL/owner-only, but an assigned APC/IPC
--    must be able to record the date too. Scope mirrors who gets reminded:
--    Boss/OL/dev = any; owner TL/PCTL = their brands; assigned APC/IPC = theirs.
create or replace function public.brand_set_last_sale_date(p_brand uuid, p_date date)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_me    uuid := auth.uid();
  v_role  text;
  v_owner uuid;
begin
  if v_me is null then raise exception 'not authenticated'; end if;
  select role into v_role from public.profiles where id = v_me and is_active = true;
  if v_role is null then raise exception 'inactive user'; end if;
  select owner_id into v_owner from public.brands where id = p_brand;
  if not found then raise exception 'brand not found'; end if;

  if not (
       v_role in ('boss', 'ol', 'developer')
    or (v_role in ('tl', 'pctl') and v_owner = v_me)
    or (v_role in ('apc', 'ipc') and exists (
          select 1 from public.brand_assignments ba
           where ba.brand_id = p_brand and ba.user_id = v_me))
  ) then raise exception 'not allowed to update this brand'; end if;

  -- p_date may be null to clear it (stops reminders for the brand).
  update public.brands set last_sale_generated_date = p_date where id = p_brand;
end;
$$;
grant execute on function public.brand_set_last_sale_date(uuid, date) to authenticated;

-- 3. Per-(user, brand, day) fire log so a brand nudges at most once a day/user.
create table if not exists public.tier_sale_reminder_log (
  user_id   uuid not null references public.profiles(id) on delete cascade,
  brand_id  uuid not null references public.brands(id)   on delete cascade,
  fire_date date not null,
  days_left int,
  fired_at  timestamptz not null default now(),
  primary key (user_id, brand_id, fire_date)
);
alter table public.tier_sale_reminder_log enable row level security;
drop policy if exists tsrl_select_own on public.tier_sale_reminder_log;
create policy tsrl_select_own on public.tier_sale_reminder_log for select
  using (user_id = auth.uid());

-- 4. Brands DUE for a sale for one user (role-scoped). "Due" = under tier
--    (tier set, not 'unlimited') + a date on record + within 3 days of the
--    30-day deadline (or already past it — negative days_left).
create or replace function public.tier_sales_due_for(p_uid uuid)
returns table (id uuid, brand_name text, tier text, last_sale_date date, deadline date, days_left int)
language plpgsql stable security definer set search_path = public
as $$
declare
  v_role  text;
  v_today date := (now() at time zone 'Asia/Karachi')::date;
begin
  select role into v_role from public.profiles where id = p_uid and is_active = true;
  if v_role is null then return; end if;

  return query
    select b.id, b.brand_name, b.tier, b.last_sale_generated_date,
           (b.last_sale_generated_date + interval '30 days')::date,
           ((b.last_sale_generated_date + interval '30 days')::date - v_today)
      from public.brands b
     where b.status = 'active'
       and b.tier is not null and trim(b.tier) <> '' and lower(b.tier) <> 'unlimited'
       and b.last_sale_generated_date is not null
       and ((b.last_sale_generated_date + interval '30 days')::date - v_today) <= 3
       and (
            v_role in ('boss', 'ol', 'developer')
         or (v_role in ('tl', 'pctl') and b.owner_id = p_uid)
         or (v_role in ('apc', 'ipc') and exists (
               select 1 from public.brand_assignments ba
                where ba.brand_id = b.id and ba.user_id = p_uid))
       )
     order by ((b.last_sale_generated_date + interval '30 days')::date - v_today) asc, b.brand_name;
end;
$$;

-- 5. Cron function — REPLACES the monthly digest. Fires each due brand once per
--    day per user from 09:00 PKT (a morning nudge; the per-day log de-dupes).
create or replace function public.notify_tier_reminders()
returns int
language plpgsql security definer set search_path = public
as $$
declare
  v_now_pkt  timestamp := (now() at time zone 'Asia/Karachi');
  v_today    date := v_now_pkt::date;
  v_fire_hour int := 9;              -- 09:00 PKT
  v_user     record;
  v_prefs    record;
  v_b        record;
  v_title    text;
  v_body     text;
  v_sent     int := 0;
begin
  if extract(hour from v_now_pkt)::int < v_fire_hour then return 0; end if;

  for v_user in
    select id, role from public.profiles
     where is_active = true and role in ('boss','ol','tl','pctl','apc','ipc')
  loop
    select * into v_prefs from public.user_tier_prefs(v_user.id);
    if not v_prefs.enabled then continue; end if;

    for v_b in select * from public.tier_sales_due_for(v_user.id)
    loop
      if exists (
        select 1 from public.tier_sale_reminder_log
         where user_id = v_user.id and brand_id = v_b.id and fire_date = v_today
      ) then continue; end if;

      if v_b.days_left > 0 then
        v_title := 'Tier sale due in ' || v_b.days_left || ' day'
                 || case when v_b.days_left = 1 then '' else 's' end || ' — ' || v_b.brand_name;
      elsif v_b.days_left = 0 then
        v_title := 'Tier sale due today — ' || v_b.brand_name;
      else
        v_title := 'Tier sale OVERDUE by ' || abs(v_b.days_left) || ' day'
                 || case when abs(v_b.days_left) = 1 then '' else 's' end || ' — ' || v_b.brand_name;
      end if;

      v_body := 'Generate a sale to keep ' || v_b.brand_name || ' (tier ' || v_b.tier
             || ') unlocked. Last sale ' || to_char(v_b.last_sale_date, 'Mon DD')
             || '. Update the date once done, or set the tier to unlimited.';

      perform public.emit_notification(
        v_user.id, null, 'tier', 'tier.sale_due',
        v_title, v_body, 'brand', v_b.id, '/brands/' || v_b.id
      );

      insert into public.tier_sale_reminder_log (user_id, brand_id, fire_date, days_left)
      values (v_user.id, v_b.id, v_today, v_b.days_left)
      on conflict do nothing;
      v_sent := v_sent + 1;
    end loop;
  end loop;

  return v_sent;
end;
$$;

-- The mig 078 pg_cron entry ('notify-tier-reminders', every 5 min) already calls
-- notify_tier_reminders(); create-or-replace keeps it pointed at the new body.
-- Re-assert it so a fresh env still schedules.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin perform cron.unschedule('notify-tier-reminders');
    exception when others then null; end;
    perform cron.schedule('notify-tier-reminders', '*/5 * * * *',
      $cron$select public.notify_tier_reminders();$cron$);
  end if;
end;
$$;
