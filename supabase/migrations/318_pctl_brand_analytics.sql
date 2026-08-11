-- ============================================================
-- WurxOS v2 — Migration 318: PCTLs can read Brand Analytics for every brand.
--
-- A PCTL already sees every brand — mig 247 put 'pctl' in can_view_brand's
-- elevated branch alongside 'ol'. What they couldn't see was the monthly
-- goal/achieved numbers, because brand_monthly_metrics is gated by
-- can_manage_brand_metrics() (Boss or active OL, mig 260).
--
-- READ ONLY, deliberately. bmm_all is a FOR ALL policy, so adding 'pctl' to
-- can_manage_brand_metrics() would hand them goal-EDITING too — and goals are
-- the Boss/OL's to set. Policies OR together for the same command, so a separate
-- SELECT policy grants exactly the read and nothing else. The page hides its
-- edit affordances for anyone who isn't Boss/OL (canEditGoals), so a PCTL sees
-- the dashboard without a Save button that RLS would then refuse.
--
-- Same shape as bmm_select_ads_manager (mig 316), minus the per-brand scoping —
-- a PCTL's brand visibility is org-wide, so their metric read is too.
-- Idempotent. Reversible by dropping this one policy.
-- ============================================================

drop policy if exists bmm_select_pctl on public.brand_monthly_metrics;
create policy bmm_select_pctl on public.brand_monthly_metrics for select
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role = 'pctl'
        and p.is_active = true
    )
  );
