-- ============================================================
-- WurxOS v2 — Migration 047: server-scheduled notification snooze
--
-- The browser service worker can't reliably sleep for 10 minutes
-- (Chrome suspends idle SWs well before that), so the old
-- setTimeout-based snooze in public/sw.js never re-fired. This
-- migration moves snooze to the server:
--
--   1. Each notification carries a one-time `snooze_token` included
--      in the push payload. The SW calls the `snooze-notification`
--      edge function with that token on snooze-click.
--   2. The edge function writes `snoozed_until = now() + N minutes`.
--   3. A pg_cron job every minute finds notifications whose snooze
--      has elapsed, clears `snoozed_until`, and re-invokes the
--      send-push webhook — the client re-sees the notification.
--
-- Safe to re-run.
-- ============================================================

alter table public.notifications
  add column if not exists snoozed_until timestamptz,
  add column if not exists snooze_token  uuid not null default gen_random_uuid();

-- Each snooze token is unique so a stale SW can't re-snooze an old one.
create unique index if not exists notifications_snooze_token_idx
  on public.notifications(snooze_token);

-- Cron sweep — kept cheap with a partial index.
create index if not exists notifications_snoozed_until_idx
  on public.notifications(snoozed_until)
  where snoozed_until is not null;

-- --------------------------------------------------------------
-- Snooze the notification identified by a token. Invoked via the
-- `snooze-notification` edge function (SECURITY DEFINER — the SW
-- has no JWT, so we authorize by possession of the token).
-- --------------------------------------------------------------
create or replace function public.snooze_notification_by_token(
  p_token   uuid,
  p_minutes int default 10
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_minutes < 1 or p_minutes > 720 then
    p_minutes := 10;
  end if;
  update public.notifications
    set snoozed_until = now() + make_interval(mins => p_minutes),
        snooze_token  = gen_random_uuid()   -- rotate so the same token can't re-snooze
    where snooze_token = p_token
    returning id into v_id;
  return v_id;
end;
$$;
grant execute on function public.snooze_notification_by_token(uuid, int) to anon, authenticated, service_role;

-- --------------------------------------------------------------
-- Re-fire notifications whose snooze has elapsed. Uses the same
-- send-push webhook the INSERT trigger uses.
-- --------------------------------------------------------------
create or replace function public.refire_snoozed_notifications()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url    text;
  v_secret text;
  v_row    record;
  v_count  int := 0;
begin
  select value into v_url    from public.app_config where key = 'send_push_url';
  select value into v_secret from public.app_config where key = 'send_push_secret';
  if v_url is null or v_url = '' then return 0; end if;

  for v_row in
    select id from public.notifications
    where snoozed_until is not null and snoozed_until <= now()
    order by snoozed_until
    limit 200
  loop
    -- Clear the snooze first so a slow webhook doesn't re-fire twice.
    update public.notifications set snoozed_until = null where id = v_row.id;

    begin
      perform net.http_post(
        url     := v_url,
        headers := jsonb_build_object(
          'Content-Type',     'application/json',
          'x-webhook-secret', coalesce(v_secret, '')
        ),
        body    := jsonb_build_object('notification_id', v_row.id)
      );
      v_count := v_count + 1;
    exception when others then
      raise warning 'refire_snoozed_notifications: send-push failed for % — %', v_row.id, sqlerrm;
    end;
  end loop;

  return v_count;
end;
$$;

-- Schedule every minute (pg_cron).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      perform cron.unschedule('refire-snoozed-notifications')
        where exists (select 1 from cron.job where jobname = 'refire-snoozed-notifications');
    exception when others then null;
    end;
    perform cron.schedule(
      'refire-snoozed-notifications',
      '* * * * *',
      $CRON$ select public.refire_snoozed_notifications(); $CRON$
    );
  end if;
end $$;
