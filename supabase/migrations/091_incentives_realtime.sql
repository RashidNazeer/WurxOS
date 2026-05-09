-- ============================================================
-- Migration 091 — Incentives realtime
--
-- Adds the `incentives` table to the supabase_realtime publication
-- so changes (verify, clear payout, progress updates) propagate to
-- every connected client without a manual reload. The subscription
-- on the page is RLS-aware: users only get events for rows they're
-- already allowed to SELECT.
-- ============================================================

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'incentives'
    ) then
      execute 'alter publication supabase_realtime add table public.incentives';
    end if;
  end if;
end $$;
