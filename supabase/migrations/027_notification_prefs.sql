-- ============================================================
-- WurxOS v2 — Migration 027: Notification preferences
--
-- Adds profiles.notification_prefs (jsonb) — per-category toggles
-- for push delivery. In-app delivery is always on; this only
-- gates the web-push dispatch.
--
-- Shape: { "<category>": { "push": bool }, ... }
-- Defaults: all categories push=true.
--
-- The push dispatch trigger consults these prefs before firing
-- the Edge Function.
-- ============================================================

alter table public.profiles
  add column if not exists notification_prefs jsonb not null
  default '{"task":{"push":true},"report":{"push":true},"brand":{"push":true},"leave":{"push":true},"paid_collab":{"push":true},"system":{"push":true}}'::jsonb;

-- Tighten the existing push-dispatch trigger to skip categories the
-- recipient has opted out of.
create or replace function public.notifications_dispatch_push()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url    text;
  v_secret text;
  v_pref   jsonb;
  v_push   bool;
begin
  begin
    select value into v_url    from public.app_config where key = 'send_push_url';
    select value into v_secret from public.app_config where key = 'send_push_secret';

    if v_url is null or v_url = '' then return new; end if;

    -- Check recipient's preference for this category (default: push on).
    select notification_prefs -> new.category into v_pref
      from public.profiles where id = new.recipient_id;
    v_push := coalesce((v_pref ->> 'push')::bool, true);
    if not v_push then return new; end if;

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
