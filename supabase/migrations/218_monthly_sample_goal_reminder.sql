-- ============================================================
-- WurxOS v2 — Migration 218: month-end reminder to set sample goals.
--
-- On the last day of each month, nudge every active APC/IPC to review
-- and set next month's per-product monthly sample goals (entered on the
-- brand's Products tab). Mirrors the salary-anniversary cron (mig 188):
-- pg_cron can't express "last day of month", so the sweep runs daily and
-- the function self-gates on today == month's last day (Asia/Karachi,
-- the org's locked timezone). Idempotent for the one-day window.
-- ============================================================

create or replace function public.monthly_sample_goal_reminder()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today    date := (now() at time zone 'Asia/Karachi')::date;
  v_last_day date := (date_trunc('month', (now() at time zone 'Asia/Karachi'))
                       + interval '1 month - 1 day')::date;
  v_rec record;
  v_total int := 0;
begin
  -- Only fire on the last calendar day of the month.
  if v_today <> v_last_day then return 0; end if;

  for v_rec in
    select id from public.profiles
     where is_active = true and deleted_at is null and role in ('apc', 'ipc')
  loop
    perform public.emit_notification(
      v_rec.id, null, 'system', 'sample_goals.reminder',
      'Set next month''s sample goals',
      'A new month starts tomorrow — review and set the monthly sample goals for your brand products (Brand → Products).',
      'brands', null, '/brands'
    );
    v_total := v_total + 1;
  end loop;
  return v_total;
end;
$$;

grant execute on function public.monthly_sample_goal_reminder() to authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('monthly-sample-goal-reminder')
      where exists (select 1 from cron.job where jobname = 'monthly-sample-goal-reminder');
    perform cron.schedule(
      'monthly-sample-goal-reminder',
      '0 4 * * *',
      $CRON$ select public.monthly_sample_goal_reminder(); $CRON$
    );
  end if;
end;
$$;
