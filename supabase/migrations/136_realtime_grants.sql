-- ============================================================
-- Migration 136 — Grant SELECT to supabase_realtime_admin
--
-- After mig 133 (REPLICA IDENTITY FULL) the attendance ClockWidget
-- still wasn't refreshing on clock-in. Verified via test harness:
-- channel SUBSCRIBED but no postgres_changes events delivered for
-- attendance / profiles / etc., even with no row-level filter.
--
-- Modern Supabase Realtime (2024+) requires `supabase_realtime_admin`
-- to have SELECT on every table in the supabase_realtime publication.
-- Without that grant the WAL decoder still produces events but Realtime
-- evaluates RLS as that role and silently drops everything because
-- the role can't read any rows.
--
-- This migration grants SELECT for every public-schema table that's
-- in the publication. Idempotent.
-- ============================================================

do $$
declare
  r record;
begin
  for r in
    select c.oid::regclass as t
    from pg_publication p
    join pg_publication_rel pr on pr.prpubid = p.oid
    join pg_class c on c.oid = pr.prrelid
    join pg_namespace n on n.oid = c.relnamespace
    where p.pubname = 'supabase_realtime'
      and n.nspname = 'public'
  loop
    -- Both supabase_realtime_admin (new role) and authenticator/authenticated
    -- need SELECT for the realtime row-filter to evaluate. authenticated
    -- already has it via PostgREST grants, but the realtime broker uses
    -- a different role chain.
    execute format('grant select on %s to supabase_realtime_admin', r.t);
    raise notice 'Granted SELECT on % to supabase_realtime_admin', r.t;
  end loop;
exception
  when undefined_object then
    -- supabase_realtime_admin role doesn't exist on this Supabase plan/version
    raise notice 'supabase_realtime_admin role not found — skipping (may not be required on this plan)';
end;
$$;
