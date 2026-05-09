-- ============================================================
-- WurxOS v2 — Migration 013: Web Push (subscriptions + dispatch)
--
-- Creates:
--   * push_subscriptions table (+ RLS: users manage their own)
--   * private app_config table (webhook URL + shared secret)
--   * trigger AFTER INSERT on notifications → pg_net POST to
--     the `send-push` Edge Function with the notification id
--
-- Prerequisites (configure after running this migration):
--   1. Deploy the `send-push` Edge Function
--   2. Set Supabase secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY,
--      VAPID_SUBJECT, PUSH_WEBHOOK_SECRET
--   3. Run:
--        update public.app_config
--           set value = 'https://<project-ref>.functions.supabase.co/send-push'
--         where key = 'send_push_url';
--        update public.app_config
--           set value = '<same PUSH_WEBHOOK_SECRET as above>'
--         where key = 'send_push_secret';
--
-- Safe to re-run.
-- ============================================================

create extension if not exists pg_net;

-- --------------------------------------------------------------
-- 1. push_subscriptions
-- --------------------------------------------------------------
create table if not exists public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  endpoint   text not null,
  p256dh     text not null,
  auth       text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  unique (endpoint)
);

create index if not exists push_subscriptions_user_idx
  on public.push_subscriptions(user_id);

alter table public.push_subscriptions enable row level security;

drop policy if exists "push_subs_select_own"  on public.push_subscriptions;
drop policy if exists "push_subs_insert_own"  on public.push_subscriptions;
drop policy if exists "push_subs_delete_own"  on public.push_subscriptions;

create policy "push_subs_select_own"
  on public.push_subscriptions for select
  using (auth.uid() = user_id);

create policy "push_subs_insert_own"
  on public.push_subscriptions for insert
  with check (auth.uid() = user_id);

create policy "push_subs_delete_own"
  on public.push_subscriptions for delete
  using (auth.uid() = user_id);

-- --------------------------------------------------------------
-- 2. app_config — private (no RLS grants); accessed only from
--    SECURITY DEFINER functions.
-- --------------------------------------------------------------
create table if not exists public.app_config (
  key   text primary key,
  value text
);

alter table public.app_config enable row level security;
-- No policies = nothing can read it directly. SECURITY DEFINER bypasses RLS.

insert into public.app_config(key, value) values
  ('send_push_url',    ''),
  ('send_push_secret', '')
on conflict (key) do nothing;

-- --------------------------------------------------------------
-- 3. Trigger: fire pg_net POST on each new notification
-- --------------------------------------------------------------
create or replace function public.notifications_dispatch_push()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url    text;
  v_secret text;
begin
  select value into v_url    from public.app_config where key = 'send_push_url';
  select value into v_secret from public.app_config where key = 'send_push_secret';

  if v_url is null or v_url = '' then
    return new;  -- not configured yet — skip silently
  end if;

  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
      'Content-Type',   'application/json',
      'x-webhook-secret', coalesce(v_secret, '')
    ),
    body    := jsonb_build_object('notification_id', new.id)
  );
  return new;
end;
$$;

drop trigger if exists notifications_dispatch_push_ai on public.notifications;
create trigger notifications_dispatch_push_ai
  after insert on public.notifications
  for each row execute function public.notifications_dispatch_push();
