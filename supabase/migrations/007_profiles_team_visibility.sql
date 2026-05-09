-- ============================================================
-- WurxOS v2 — Migration 007: team-visible profiles
--
-- Problem: the strict "self-or-boss" profiles SELECT policy means
-- teammates can't see each other's names. Joins like
--   brand_assignments.profile:user_id(...)
--   tasks.assignee:assignee_id(...)
--   tasks.creator:created_by(...)
-- come back with `null` for non-self non-boss users — so the UI
-- shows blanks everywhere for APCs, IPCs, TLs viewing each other.
--
-- Fix: allow every active authenticated user to SELECT any profile.
-- This is the same visibility any team/workspace app needs.
-- Sensitive fields (reset_schedule, permissions) remain on the same
-- row but are only functionally sensitive to their owner — if we
-- ever need to hide them from non-owners, we'll introduce a view.
--
-- Safe to re-run.
-- ============================================================

drop policy if exists "profiles_select_self_or_boss" on public.profiles;
drop policy if exists "profiles_select_any_authenticated" on public.profiles;

create policy "profiles_select_any_authenticated"
  on public.profiles for select
  using (auth.role() = 'authenticated');

-- UPDATE policy stays the same: self or Boss can update.
-- INSERT remains blocked (handled by handle_new_user trigger).
