-- ============================================================
-- WurxOS v2 — Migration 277: lock down the TL reporting-component helpers.
--
-- Review of mig 276 found: tl_report_stars_score + tl_report_accountability are
-- SECURITY DEFINER (bypass RLS), take an arbitrary p_tl, carry NO internal
-- visibility check, and were granted to `authenticated` — so any logged-in user
-- could RPC them directly and read any TL's OL star score / return accountability
-- (component data gated to boss/ol/self/manager everywhere else). This is NOT
-- switch-gated. The grant is unnecessary: the only callers (tl_reporting_score,
-- tl_perf_preview, list_tl_reporting, get_performance_composite) are SECURITY
-- DEFINER and invoke these AS THE OWNER, who keeps EXECUTE regardless.
--
-- Revoke `authenticated` (keep service_role). Safe to re-run.
-- ============================================================

revoke execute on function public.tl_report_stars_score(uuid, text)   from authenticated, public, anon;
grant  execute on function public.tl_report_stars_score(uuid, text)   to service_role;

revoke execute on function public.tl_report_accountability(uuid, text) from authenticated, public, anon;
grant  execute on function public.tl_report_accountability(uuid, text) to service_role;
