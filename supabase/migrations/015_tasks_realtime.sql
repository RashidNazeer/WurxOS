-- ============================================================
-- WurxOS v2 — Migration 015: add `tasks` to Realtime publication
--
-- Lets the frontend subscribe to INSERT/UPDATE/DELETE events on
-- tasks so status changes, reassignments, and new tasks appear
-- instantly without a manual refresh.
--
-- Safe to re-run.
-- ============================================================

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tasks'
    ) then
      execute 'alter publication supabase_realtime add table public.tasks';
    end if;
  end if;
end;
$$;

-- REPLICA IDENTITY FULL so UPDATE events include the old row
-- (needed when filters depend on pre-change values).
alter table public.tasks replica identity full;
