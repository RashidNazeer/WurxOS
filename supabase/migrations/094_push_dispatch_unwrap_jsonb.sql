-- ============================================================
-- Migration 094 — Push dispatch: unwrap jsonb url/secret strings
--
-- The dispatcher trigger (added in 014, re-stamped by 027 and
-- 047) reads send_push_url + send_push_secret from public.app_config
-- with `select value into v_url`, where `value` is jsonb but
-- `v_url` is text. Postgres' implicit jsonb→text cast preserves
-- the JSON quoting, so a value of "https://example/send-push" gets
-- assigned to v_url as the literal string  "https://example/send-push"
-- (with the surrounding quotes). net.http_post then POSTs to that
-- malformed URL and the push silently never lands.
--
-- Fix: read with `value #>> '{}'` to unwrap the scalar to text.
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
    select value #>> '{}' into v_url    from public.app_config where key = 'send_push_url';
    select value #>> '{}' into v_secret from public.app_config where key = 'send_push_secret';

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

-- Re-create the same fix on refire_snoozed_notifications (047), which
-- also reads from app_config the same way.
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
  select value #>> '{}' into v_url    from public.app_config where key = 'send_push_url';
  select value #>> '{}' into v_secret from public.app_config where key = 'send_push_secret';

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
