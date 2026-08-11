-- ============================================================
-- 313 — Realtime for brand_monthly_metrics so the Brand Analytics dashboard
-- updates LIVE as APCs submit GMV at clock-in. Subscribers are still gated by
-- the table's RLS (can_manage_brand_metrics = boss/active-ol), which matches the
-- /analytics/brands route guard, so only managers receive the stream.
-- ============================================================
do $$ begin
  alter publication supabase_realtime add table public.brand_monthly_metrics;
exception when duplicate_object then null; end $$;
