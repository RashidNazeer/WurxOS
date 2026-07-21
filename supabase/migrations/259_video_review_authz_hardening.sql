-- ============================================================
-- WurxOS v2 — Migration 259: harden the file-based Video Reviews access check.
--
-- 258 shipped can_use_video_reviews(p_brand, uid) taking a CALLER-SUPPLIED uid,
-- granted to authenticated. The RLS policies always pass auth.uid(), but the
-- function could be invoked directly with an arbitrary uid, turning it into a
-- boolean oracle for "is user X boss?" and "is user X assigned to brand Y?".
-- No data rows leaked (table RLS held), but it exposed org structure.
--
-- Fix: read auth.uid() INSIDE the function (drop the uid parameter). Identical
-- RLS behavior, no arbitrary-uid probing. Same lesson as the SECURITY DEFINER
-- hardening in migs 251/252.
-- ============================================================

-- Policies reference the 2-arg function, so drop them first.
drop policy if exists vrs_all on public.video_review_settings;
drop policy if exists vrp_all on public.video_review_progress;
drop function if exists public.can_use_video_reviews(uuid, uuid);

create or replace function public.can_use_video_reviews(p_brand uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select
    public.is_boss(auth.uid())
    or exists (
      select 1 from public.brand_assignments ba
      where ba.brand_id = p_brand and ba.user_id = auth.uid()
    );
$$;
revoke all on function public.can_use_video_reviews(uuid) from public, anon;
grant execute on function public.can_use_video_reviews(uuid) to authenticated;

create policy vrs_all on public.video_review_settings
  for all
  using (public.can_use_video_reviews(brand_id))
  with check (public.can_use_video_reviews(brand_id));

create policy vrp_all on public.video_review_progress
  for all
  using (public.can_use_video_reviews(brand_id))
  with check (public.can_use_video_reviews(brand_id));
