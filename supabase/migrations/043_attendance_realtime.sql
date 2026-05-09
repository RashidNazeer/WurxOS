-- ============================================================
-- WurxOS v2 — Migration 043: Attendance realtime
--
-- Adds public.attendance to the supabase_realtime publication so
-- the Attendance page can react to teammates clocking in / out /
-- on break in real time.
-- ============================================================

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename  = 'attendance'
    ) then
      execute 'alter publication supabase_realtime add table public.attendance';
    end if;
  end if;
end;
$$;
