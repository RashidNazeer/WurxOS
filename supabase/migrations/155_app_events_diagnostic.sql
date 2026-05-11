-- ============================================================
-- WurxOS v2 — Migration 155: app_events diagnostic table
--
-- Purpose: capture client-side events that contribute to the "the
-- app keeps refreshing" symptom so we can identify the actual cause
-- the next time it happens. Currently the user reports refreshes
-- without enough context to fix the root cause; this lets us run
-- ONE SQL query after a report and see exactly what fired.
--
-- The table is tiny (one row per event), auto-prunes older than 30
-- days, and only signed-in users can write (RLS).
--
-- Logged events (kind):
--   * auth.bootstrap         — initial session resolution at app start
--   * auth.token_refreshed   — Supabase fired TOKEN_REFRESHED
--   * auth.signed_in         — explicit sign-in
--   * auth.signed_out        — explicit sign-out
--   * auth.session_invalid   — recheck flagged session as dead
--   * auth.recheck_fail      — recheck failed (consecutive count tracked)
--   * route.changed          — react-router pushState
--   * page.visibility        — visibilitychange (hidden → visible)
--   * realtime.subscribed    — a postgres_changes channel was opened
--   * realtime.error         — channel errored or got desync
--
-- Reading: `select * from app_events where user_id = '...' order by
-- created_at desc limit 50` gives a timeline. Cause-of-refresh
-- usually shows up as: token_refreshed → session_invalid quickly
-- after, or as a flood of route.changed entries.
-- ============================================================

create table if not exists public.app_events (
  id          bigserial primary key,
  user_id     uuid references public.profiles(id) on delete set null,
  kind        text not null,
  detail      jsonb not null default '{}'::jsonb,
  route       text,
  user_agent  text,
  created_at  timestamptz not null default now()
);

create index if not exists app_events_user_idx     on public.app_events(user_id, created_at desc);
create index if not exists app_events_kind_idx     on public.app_events(kind, created_at desc);
create index if not exists app_events_recent_idx   on public.app_events(created_at desc);

-- RLS: a signed-in user can write events tagged as their own.
-- Reads are restricted to the user themselves + Boss/Developer.
alter table public.app_events enable row level security;

drop policy if exists "app_events_insert_self" on public.app_events;
create policy "app_events_insert_self"
  on public.app_events for insert
  with check (auth.uid() = user_id);

drop policy if exists "app_events_select_self_or_admin" on public.app_events;
create policy "app_events_select_self_or_admin"
  on public.app_events for select
  using (
    auth.uid() = user_id
    or public.is_boss(auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'developer' and p.is_active = true
    )
  );

-- Auto-prune anything older than 30 days. Cheap to run; the table
-- shouldn't grow large enough to matter, but keeps it bounded.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin perform cron.unschedule('app-events-prune'); exception when others then null; end;
    perform cron.schedule(
      'app-events-prune',
      '17 3 * * *',  -- daily at 03:17 UTC
      $cron$ delete from public.app_events where created_at < now() - interval '30 days'; $cron$
    );
  end if;
end;
$$;
