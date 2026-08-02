-- ============================================================
-- 298 — Performance-overhaul go-live review fixes (pre-flip hardening).
--
-- (1) SECURITY: notify_pending_apc_ratings() is SECURITY DEFINER with no in-body
--     caller check and calls emit_notification (inserts notifications + push). It
--     was only ever GRANTed to service_role (for the cron), but the default PUBLIC
--     execute grant was never revoked → any logged-in user could RPC it and spam
--     every OL with pending-rating notifications/push. Revoke public/anon/auth
--     (the cron runs as the function owner, so it is unaffected). Same lesson as
--     migs 277/278 — this one was missed.
--
-- (2) TIMEZONE/PARITY: perf_flags_score (the flags pillar of EVERY composite;
--     latest def mig 256) computes its month window with a bare ::timestamptz =
--     the session zone (UTC on service_role), while the JS composite mirror
--     (composite-parity.mjs) buckets flags by Karachi month (khiMonth). They only
--     agree today because no flag sits in the ~5h UTC/Karachi edge. Karachi-anchor
--     the SQL window so it matches the JS side (and the rest of the codebase —
--     migs 218/252/256/273). Pre-existing + switch-independent, but it feeds
--     salary, so fix it as part of go-live hardening. Body otherwise verbatim.
-- ============================================================

-- (1) ----------------------------------------------------------------
revoke execute on function public.notify_pending_apc_ratings() from public, anon, authenticated;
-- (service_role grant from mig 270 stays; the pg_cron job runs as the owner.)

-- (2) ----------------------------------------------------------------
create or replace function public.perf_flags_score(p_user uuid, p_month text)
returns numeric
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_green int := 0;
  v_red   int := 0;
  -- Karachi-anchored month window (was bare ::timestamptz = session/UTC zone).
  v_start timestamptz := (p_month || '-01')::timestamp at time zone 'Asia/Karachi';
  v_end   timestamptz := ((p_month || '-01')::date + interval '1 month')::timestamp at time zone 'Asia/Karachi';
begin
  select
    coalesce(count(*) filter (where f.type = 'green'), 0),
    coalesce(count(*) filter (where f.type is distinct from 'green'), 0)
    into v_green, v_red
    from public.performance_flags f
   where f.user_id = p_user
     and f.created_at >= v_start
     and f.created_at <  v_end;

  return greatest(0, least(100, 80 + v_green * 10 - v_red * 20));
end;
$$;
revoke execute on function public.perf_flags_score(uuid, text) from public, anon;
grant  execute on function public.perf_flags_score(uuid, text) to authenticated, service_role;
