-- ============================================================
-- Migration 097 — Revert 094's jsonb-unwrap of app_config values
--
-- 094 changed `select value into v_url` to `select value #>> '{}' into v_url`,
-- assuming app_config.value was jsonb. It is actually `text`. The
-- `text #>> '{}'` operator does not exist, so the function raised an
-- exception which the surrounding `exception when others then raise
-- warning` block swallowed silently, leaving v_url null and skipping
-- the http_post entirely. End result: every notification insert since
-- 094 deployed has been a no-op for push delivery.
--
-- Restore the original assignment.
-- ============================================================

create or replace function public.notifications_dispatch_push()
returns trigger
language plpgsql
security definer
set search_path = public, net
as $$
declare
  v_url    text;
  v_secret text;
begin
  begin
    select value into v_url    from public.app_config where key = 'send_push_url';
    select value into v_secret from public.app_config where key = 'send_push_secret';

    if v_url is null or v_url = '' then
      return new;
    end if;

    perform net.http_post(
      url     := v_url,
      headers := jsonb_build_object(
        'Content-Type',    'application/json',
        'x-webhook-secret', coalesce(v_secret, '')
      ),
      body    := jsonb_build_object('notification_id', new.id)
    );
  exception when others then
    raise warning 'notifications_dispatch_push failed: %', sqlerrm;
  end;
  return new;
end;
$$;

create or replace function public.refire_snoozed_notifications()
returns int
language plpgsql
security definer
set search_path = public, net
as $$
declare
  v_url    text;
  v_secret text;
  v_row    public.notifications;
  v_count  int := 0;
begin
  select value into v_url    from public.app_config where key = 'send_push_url';
  select value into v_secret from public.app_config where key = 'send_push_secret';

  for v_row in
    select * from public.notifications
    where snoozed_until is not null
      and snoozed_until <= now()
      and snooze_fired_at is null
    order by snoozed_until asc
    limit 500
  loop
    update public.notifications
       set snooze_fired_at = now()
     where id = v_row.id;

    if v_url is not null and v_url <> '' then
      begin
        perform net.http_post(
          url := v_url,
          headers := jsonb_build_object(
            'Content-Type',    'application/json',
            'x-webhook-secret', coalesce(v_secret, '')
          ),
          body := jsonb_build_object('notification_id', v_row.id)
        );
      exception when others then
        raise warning 'refire_snoozed_notifications: send-push failed for % — %', v_row.id, sqlerrm;
      end;
    end if;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;
