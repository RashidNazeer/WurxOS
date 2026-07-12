-- ============================================================
-- WurxOS v2 — Migration 240: Reports realtime
--
-- Adds public.reports to the supabase_realtime publication so the report
-- LIST pages (weekly / bi-weekly / monthly) can live-update when a report's
-- status changes (submitted → approved → verified / rejected) or a report is
-- created/deleted — no manual refresh. RLS on `reports` still gates which
-- change events each client receives, so a TL/APC only ever hears about
-- reports they can already see.
--
-- Idempotent + additive. Same guarded pattern as mig 043 (attendance).
-- ============================================================

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename  = 'reports'
    ) then
      execute 'alter publication supabase_realtime add table public.reports';
    end if;
  end if;
end;
$$;
