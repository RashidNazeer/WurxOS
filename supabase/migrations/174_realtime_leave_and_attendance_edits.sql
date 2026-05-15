-- ============================================================
-- WurxOS v2 — Migration 174: make the leave + attendance-edit
-- flows truly realtime.
--
-- User report (2026-05-15): leave-request approvals and attendance
-- clock-edit approvals don't update live — a manager or requester
-- has to refresh the page to see a request move through the chain.
--
-- Root cause: the frontend already subscribes to postgres_changes on
-- `leave_requests` (subscribeLeaves) and `attendance_edit_requests`
-- (onActiveRecord / onPendingEditClockOutRequests), but neither table
-- was ever added to the `supabase_realtime` publication. Postgres
-- only broadcasts changes for published tables, so those channels
-- sat silent and the UI only updated on the actor's OWN action (via
-- a manual refetch) — never for other users. (`attendance` itself
-- was published back in mig 043, which is why the roster works.)
--
-- This adds both tables to the publication, sets REPLICA IDENTITY
-- FULL (needed so UPDATE/DELETE deliver the full row, and so the
-- filtered subscription in onActiveRecord can match on user_id), and
-- grants SELECT to supabase_realtime_admin so RLS can be evaluated
-- against the row payload.
--
-- Idempotent. Modeled on mig 139.
-- ============================================================

do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise notice 'supabase_realtime publication not present — skipping';
    return;
  end if;

  for t in select unnest(array[
    'leave_requests',
    'attendance_edit_requests'
  ])
  loop
    -- Add to publication if not already there.
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename  = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
      raise notice 'Added % to supabase_realtime', t;
    else
      raise notice '% already in supabase_realtime', t;
    end if;

    -- REPLICA IDENTITY FULL so UPDATE/DELETE deliver the full row
    -- (and filtered subscriptions can match on non-PK columns).
    execute format('alter table public.%I replica identity full', t);

    -- Grant SELECT to supabase_realtime_admin so RLS can be evaluated
    -- against the row payload.
    begin
      execute format('grant select on public.%I to supabase_realtime_admin', t);
    exception when undefined_object then
      null; -- role may not exist on this Supabase plan
    end;
  end loop;
end;
$$;
