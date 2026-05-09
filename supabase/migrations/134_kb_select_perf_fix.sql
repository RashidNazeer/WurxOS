-- ============================================================
-- Migration 134 — kb_articles SELECT policy performance fix
--
-- Symptom (reported 2026-05-07): KB page hung with infinite spinner
-- for APC/OL/TL roles; only Boss loaded fine. Browser network tab
-- showed 504 Gateway Timeout on the kb_articles GET.
--
-- Root cause: the existing `kb_select` policy (mig 063) calls
-- `is_boss(auth.uid())` and runs an `exists (select 1 from profiles
-- where p.id = auth.uid() ...)` subquery PER ROW. With 133 articles
-- and the planner re-evaluating these per-row sub-queries, the query
-- is taking >30s for non-boss roles → API gateway 504.
--
-- Fix: wrap the auth.uid() lookups in `(select auth.uid())` and the
-- role lookups in `(select role from profiles where id = auth.uid())`
-- so the Postgres planner recognizes them as constant for the query
-- and runs each at most once. This is the standard Supabase pattern
-- for performant RLS — see https://supabase.com/docs/guides/database/postgres/row-level-security#use-security-definer-functions
-- and the "wrap auth.uid() in a select" optimization specifically.
--
-- Boss still sees everything; OL/Dev still see everything; everyone
-- else still sees approved + matching visibility. Logic is identical;
-- only the evaluation order changes.
-- ============================================================

drop policy if exists "kb_select" on public.kb_articles;
create policy "kb_select" on public.kb_articles for select
  using (
    -- Cache auth.uid() and the caller's role once via scalar
    -- subqueries so Postgres only computes them once for the whole
    -- query, not per row.
    created_by = (select auth.uid())
    or submitted_by = (select auth.uid())
    or (select public.is_boss((select auth.uid())))
    or (select role from public.profiles where id = (select auth.uid())) in ('ol', 'developer')
    or (
      approval_status = 'approved'
      and (
        visibility = 'office'
        or (visibility = 'role'
            and (select role from public.profiles where id = (select auth.uid())) = any (visible_to_roles))
        or (visibility = 'users' and (select auth.uid()) = any (visible_to_users))
      )
    )
  );
