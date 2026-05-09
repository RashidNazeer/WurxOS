-- ============================================================
-- Migration 133 — REPLICA IDENTITY FULL on attendance + profiles
--
-- Symptom (reported 2026-05-07): clicking "Clock In" updated the DB
-- but the ClockWidget didn't refresh until the user reloaded. The
-- realtime channel subscribed successfully but `postgres_changes`
-- events never fired.
--
-- Root cause: by default Postgres tables emit only the primary-key
-- columns in the WAL for UPDATE/DELETE. Supabase realtime then can't
-- evaluate RLS against the full row (it only sees `id`), so it
-- silently drops the event for any subscriber that has a row-filter
-- — which is exactly how `onActiveRecord(uid)` is wired
-- (`filter: user_id=eq.<uid>`).
--
-- Fix: set REPLICA IDENTITY FULL so every column lands in the WAL
-- and realtime can apply both the channel filter and RLS correctly.
-- This is the recommended setting for any table in
-- supabase_realtime publication.
--
-- Apply to attendance (the reported symptom) AND every other table
-- already in the publication so we don't have the same bug lurking
-- on profiles/campaigns/etc.
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
      and c.relreplident <> 'f'   -- skip tables already FULL
  loop
    execute format('alter table %s replica identity full', r.t);
    raise notice 'Set REPLICA IDENTITY FULL on %', r.t;
  end loop;
end;
$$;
