-- ============================================================
-- Migration 096 — Allow users to delete their own tier_notification_log
--
-- The TierNotifications settings page rearms the cron when a user
-- changes their slot day/time by deleting the matching log row for
-- the current month. Without this policy the delete silently does
-- nothing under RLS (service role would work, but we want this to
-- run as the signed-in user from the browser).
--
-- Scope is intentionally narrow: only your own rows.
-- ============================================================

drop policy if exists "tnl_delete_own" on public.tier_notification_log;
create policy "tnl_delete_own" on public.tier_notification_log
  for delete
  using (user_id = auth.uid());
