-- ============================================================
-- WurxOS v2 — Migration 210: time-boxed (temporary) brand assignments.
--
-- TLs (brand owners) and OL/Boss can assign a brand to any APC/IPC for
-- temporary cover (e.g. the usual APC is unavailable). The assignee gets the
-- same access as a normal assignment via can_view_brand / the report+task
-- policies that read brand_assignments. A nullable expires_at marks temporary
-- ones; a pg_cron job removes them once expired, at which point access ends
-- everywhere (the row is gone). Null expires_at = permanent (unchanged).
--
-- No RLS change needed: brand_assignments INSERT already requires
-- can_edit_brand(brand.owner_id, auth.uid()) — true for Boss/OL/Developer AND
-- the brand's owning TL — which is exactly "only brands they lead" for a TL.
--
-- Idempotent.
-- ============================================================

alter table public.brand_assignments
  add column if not exists expires_at timestamptz;

-- Remove temporary assignments once their window has passed. SECURITY DEFINER
-- so the scheduled job (no auth context) can delete regardless of RLS.
create or replace function public.expire_brand_assignments()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.brand_assignments
  where expires_at is not null and expires_at <= now();
$$;

-- Run every 15 minutes (expiry is day-level, so this granularity is plenty).
do $$
begin
  perform cron.unschedule('expire-brand-assignments');
exception when others then null;  -- not scheduled yet
end $$;
select cron.schedule('expire-brand-assignments', '*/15 * * * *',
  $$select public.expire_brand_assignments();$$);
