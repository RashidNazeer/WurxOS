-- ============================================================
-- 289 — Lock down the tier-reminder SECURITY DEFINER helpers.
--
-- tier_sales_due_for / notify_tier_reminders (migs 287/288) and the pre-existing
-- brands_under_tier_for / user_tier_prefs (mig 078) are SECURITY DEFINER but were
-- never revoked from PUBLIC, so Postgres' default GRANT EXECUTE TO PUBLIC left them
-- exposed as PostgREST RPCs. tier_sales_due_for is the dangerous one: it authorizes
-- on the PASSED p_uid, not auth.uid(), so any authenticated user could call
-- rpc('tier_sales_due_for', { p_uid: <a Boss/OL uuid> }) and enumerate EVERY active
-- non-'unlimited' brand's id/name/tier/last_sale_date/deadline — an RLS bypass.
--
-- None are called from the frontend. The only caller is the pg_cron job, which
-- runs as the function OWNER (postgres) and the internal notify→due call runs as
-- the definer — the owner keeps EXECUTE regardless of these revokes, so the cron
-- is unaffected. Matches the lockdown convention on every sibling definer helper.
-- ============================================================
revoke execute on function public.tier_sales_due_for(uuid)    from public, anon, authenticated;
revoke execute on function public.notify_tier_reminders()     from public, anon, authenticated;
revoke execute on function public.brands_under_tier_for(uuid) from public, anon, authenticated;
revoke execute on function public.user_tier_prefs(uuid)       from public, anon, authenticated;
