-- ============================================================
-- WurxOS v2 — Migration 188: daily work-anniversary sweep
--
-- Runs once per day. For each active payroll employee whose
-- profiles.start_date month/day matches today (Asia/Karachi),
-- sends one notification per active Boss with the message:
--
--   "Ali Hamza has completed 2 years and is eligible for salary
--    review."
--
-- The sweep is idempotent — last_year_boss_notified on
-- anniversary_celebrations prevents double-firing within the same
-- year, so the cron is safe to run hourly or run once per day. We
-- schedule it daily at 04:00 UTC which is 09:00 in Karachi.
--
-- Boss role excluded from the sweep target list (Boss has no
-- payroll record — see memory/salary-management.md). Past
-- anniversaries that occurred BEFORE this migration ran will NOT
-- back-fire; the Pending Reviews tab in the Boss UI surfaces those
-- separately via client-side computation.
-- ============================================================

-- Boss-notify tracking column. Distinct from last_year_shown
-- (employee banner dismissal) so the two concerns don't fight.
alter table public.anniversary_celebrations
  add column if not exists last_year_boss_notified int;

-- ════════════════════════════════════════════════════════════════
-- daily_anniversary_sweep — invoked by pg_cron once per day
-- ════════════════════════════════════════════════════════════════
create or replace function public.daily_anniversary_sweep()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today_pkt date := (now() at time zone 'Asia/Karachi')::date;
  v_today_md  text;
  v_emp       record;
  v_boss      record;
  v_years     int;
  v_last      int;
  v_total     int := 0;
begin
  v_today_md := to_char(v_today_pkt, 'MM-DD');

  for v_emp in
    select p.id, p.display_name, p.email, p.start_date, p.role
      from public.profiles p
     where p.is_active = true
       and p.deleted_at is null
       and p.role in ('ol','tl','pctl','apc','ipc','developer')
       and p.start_date is not null
       and p.start_date < v_today_pkt
       and to_char(p.start_date, 'MM-DD') = v_today_md
  loop
    v_years := extract(year from age(v_today_pkt, v_emp.start_date))::int;
    if v_years < 1 then
      continue;
    end if;

    -- Dedupe: skip if already notified for this year.
    select last_year_boss_notified into v_last
      from public.anniversary_celebrations
     where user_id = v_emp.id;

    if v_last is not null and v_last >= v_years then
      continue;
    end if;

    -- Stamp the dedupe row FIRST so retries within the same tick
    -- don't double-notify.
    insert into public.anniversary_celebrations (user_id, last_year_shown, last_year_boss_notified, shown_at)
    values (v_emp.id, coalesce(v_last, 0), v_years, now())
    on conflict (user_id) do update
       set last_year_boss_notified = v_years;

    -- Notify every active Boss.
    for v_boss in
      select id from public.profiles
       where role = 'boss' and is_active = true and deleted_at is null
    loop
      perform public.emit_notification(
        v_boss.id, null, 'hr', 'anniversary.completed',
        coalesce(v_emp.display_name, v_emp.email, 'An employee') || ' work anniversary',
        coalesce(v_emp.display_name, v_emp.email, 'An employee')
          || ' has completed ' || v_years
          || case when v_years = 1 then ' year' else ' years' end
          || ' and is eligible for salary review.',
        'profiles', v_emp.id, '/boss/salaries'
      );
      v_total := v_total + 1;
    end loop;
  end loop;

  return v_total;
end;
$$;
grant execute on function public.daily_anniversary_sweep() to authenticated;

-- ── Schedule via pg_cron ──────────────────────────────────────
-- 04:00 UTC == 09:00 Asia/Karachi. Daily.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('daily-anniversary-sweep')
      where exists (select 1 from cron.job where jobname = 'daily-anniversary-sweep');
    perform cron.schedule(
      'daily-anniversary-sweep',
      '0 4 * * *',
      $CRON$ select public.daily_anniversary_sweep(); $CRON$
    );
  end if;
end;
$$;
