-- ============================================================
-- WurxOS v2 — Migration 341: Team Leads and APCs can read Brand Analytics,
-- for THEIR OWN brands only.
--
-- Until now brand_monthly_metrics was readable by Boss/OL (bmm_all, mig 260),
-- ads managers for their granted brands (bmm_select_ads_manager, mig 316) and
-- PCTLs org-wide (bmm_select_pctl, mig 318). A TL could not see the monthly
-- goal and achieved figures for a brand they own, and an APC could not see them
-- for a brand they run — even though both already open those brands everywhere
-- else in the app, and the APC is the person who TYPES the achieved figure at
-- clock-in (mig 311).
--
-- READ ONLY, deliberately — same reasoning as mig 318. bmm_all is a FOR ALL
-- policy, so widening can_manage_brand_metrics() would hand out goal EDITING.
-- Goals stay the Boss/OL's to set. Policies OR together per command, so a
-- separate SELECT policy grants exactly the read and nothing more. The page
-- already hides every edit affordance for anyone who is not Boss/OL/developer
-- (canEditGoals in BrandAnalyticsPage), so a TL or APC sees the dashboard
-- without a Save button that RLS would then refuse.
--
-- SCOPED PER BRAND, unlike the PCTL policy. The scoping deliberately mirrors
-- how each role's brands are defined everywhere else in this schema:
--   TL  -> brands.owner_id      (a TL owns the brand)
--   APC -> brand_assignments    (an APC is assigned to it)
-- Written out explicitly rather than calling can_view_brand(), because that
-- helper also resolves IPCs, ads managers and the elevated OL/PCTL branch —
-- reusing it here would silently widen this grant every time can_view_brand
-- changes for an unrelated reason. This policy should grant what it says.
--
-- TEMPORARY COVER COUNTS. brand_assignments rows with a non-null expires_at are
-- time-boxed cover (mig 210). Mig 338 excluded cover from ENTERING a brand's
-- GMV, because covering does not mean owning the numbers. Reading them is the
-- opposite case: someone covering a brand needs to see where it stands to do
-- the work at all. So no expires_at filter here, on purpose.
--
-- Idempotent. Reversible by dropping these two policies.
-- ============================================================

-- ── TL: the brands they own ─────────────────────────────────────────────────
drop policy if exists bmm_select_tl_own on public.brand_monthly_metrics;
create policy bmm_select_tl_own on public.brand_monthly_metrics for select
  using (
    exists (
      select 1
        from public.profiles p
        join public.brands b on b.id = brand_monthly_metrics.brand_id
       where p.id = auth.uid()
         and p.role = 'tl'
         and p.is_active = true
         and b.owner_id = p.id
    )
  );

-- ── APC: the brands they are assigned to (cover included) ───────────────────
drop policy if exists bmm_select_apc_assigned on public.brand_monthly_metrics;
create policy bmm_select_apc_assigned on public.brand_monthly_metrics for select
  using (
    exists (
      select 1
        from public.profiles p
        join public.brand_assignments ba
          on ba.user_id = p.id
         and ba.brand_id = brand_monthly_metrics.brand_id
       where p.id = auth.uid()
         and p.role = 'apc'
         and p.is_active = true
    )
  );

-- ── Verification ────────────────────────────────────────────────────────────
do $verify$
declare
  v_tl    int;
  v_apc   int;
  v_write int;
begin
  select count(*) into v_tl  from pg_policies
   where schemaname = 'public' and tablename = 'brand_monthly_metrics'
     and policyname = 'bmm_select_tl_own' and cmd = 'SELECT';
  select count(*) into v_apc from pg_policies
   where schemaname = 'public' and tablename = 'brand_monthly_metrics'
     and policyname = 'bmm_select_apc_assigned' and cmd = 'SELECT';
  if v_tl <> 1 or v_apc <> 1 then
    raise exception 'mig 341: expected both SELECT policies (tl=%, apc=%)', v_tl, v_apc;
  end if;

  -- Neither policy may grant anything but SELECT. If either ever shows up as
  -- ALL/INSERT/UPDATE, goal editing has leaked to a role that must not have it.
  select count(*) into v_write from pg_policies
   where schemaname = 'public' and tablename = 'brand_monthly_metrics'
     and policyname in ('bmm_select_tl_own', 'bmm_select_apc_assigned')
     and cmd <> 'SELECT';
  if v_write <> 0 then
    raise exception 'mig 341: a TL/APC policy grants more than SELECT — goals must stay Boss/OL';
  end if;

  raise notice 'mig 341: TL and APC can now READ brand metrics for their own brands only';
end;
$verify$;
