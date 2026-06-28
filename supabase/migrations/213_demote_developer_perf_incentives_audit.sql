-- ============================================================
-- WurxOS v2 — Migration 213: demote `developer` from the remaining
-- SENSITIVE data domains — performance, incentives, audit log.
--
-- Continues the developer lock-down started in mig 212 (brands /
-- reports / analytics). Mig 185 already excluded developer from
-- salaries. This removes developer's elevated access to the other
-- genuinely-sensitive surfaces:
--   • performance ratings / flags / warnings (employee evaluations)
--   • incentives (pay plans / payouts)
--   • audit_log (full company change history)
--
-- Each object is recreated VERBATIM from its authoritative latest
-- definition, changing ONLY the `developer` literal. Every other
-- role's access is byte-identical. RLS is evaluated live — no backfill.
--
-- RESIDUAL (intentionally NOT demoted here — operational / low
-- sensitivity, and already blocked for developer at the frontend
-- route-guard layer): attendance & leave OF OTHERS, the brand-switch
-- SECURITY DEFINER RPCs, KB, broadcasts, resources, tasks, paid-collab,
-- product/campaign data. Demoting those means recreating ~25 more
-- policies/long RPCs verbatim — high regression risk for a trusted
-- internal role with no proven leak. Do that as a later staged change
-- if desired. The incentives verify/payout RPCs (mig 059) are likewise
-- left as residual (SECURITY DEFINER writes, UI-blocked); the table
-- policies below already block a developer from reading/writing the
-- incentives table directly.
--
-- Idempotent.
-- ============================================================

-- ── 1. PERFORMANCE ──────────────────────────────────────────
-- can_eval_perf (mig 032): drop `developer` from the elevated branch.
create or replace function public.can_eval_perf(p_target uuid, p_actor uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select
    public.is_boss(p_actor)
    or exists (select 1 from public.profiles p where p.id = p_actor and p.role = 'ol' and p.is_active = true)
    or exists (select 1 from public.profiles p where p.id = p_target and p.reports_to = p_actor);
$$;

-- perf *_select policies (mig 032): the inline `role in ('ol','developer')`
-- branch is separate from can_eval_perf, so demote it here too. Verbatim
-- from 032's do-loop, changing only the developer literal. (The *_write
-- policies use can_eval_perf, so the function change above covers them;
-- performance_warnings_write is handled separately below.)
do $$
declare t text;
begin
  foreach t in array array['performance_ratings','performance_flags','performance_warnings'] loop
    execute format('drop policy if exists "%s_select" on public.%I', t, t);
    execute format($p$create policy "%s_select" on public.%I for select using (
      auth.uid() = user_id
      or public.is_boss(auth.uid())
      or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'ol' and p.is_active = true)
      or public.can_eval_perf(user_id, auth.uid())
    )$p$, t, t);
  end loop;
end;
$$;

-- performance_warnings write (mig 061 was Boss+Developer): drop developer
-- -> Boss-only, matching the migration's own "Boss only" intent.
drop policy if exists "performance_warnings_write" on public.performance_warnings;
create policy "performance_warnings_write"
  on public.performance_warnings for all
  using (public.is_boss(auth.uid()))
  with check (public.is_boss(auth.uid()));

-- ── 2. INCENTIVES ───────────────────────────────────────────
-- inc_select / inc_insert (mig 033) and inc_update (mig 089): drop
-- `developer` from each elevated branch (-> Boss/OL + self/manager as before).
drop policy if exists "inc_select" on public.incentives;
create policy "inc_select"
  on public.incentives for select
  using (
    auth.uid() = user_id
    or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'ol' and p.is_active = true)
    or exists (select 1 from public.profiles p where p.id = incentives.user_id and p.reports_to = auth.uid())
  );

drop policy if exists "inc_insert" on public.incentives;
create policy "inc_insert"
  on public.incentives for insert
  with check (
    public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'ol' and p.is_active = true)
  );

drop policy if exists "inc_update" on public.incentives;
create policy "inc_update"
  on public.incentives for update
  using (
    auth.uid() = user_id
    or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'ol' and p.is_active = true)
  )
  with check (
    auth.uid() = user_id
    or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'ol' and p.is_active = true)
  );

-- ── 3. AUDIT LOG ────────────────────────────────────────────
-- audit_select (mig 156 was Boss+Developer): drop developer -> Boss-only.
drop policy if exists "audit_select" on public.audit_log;
create policy "audit_select"
  on public.audit_log for select
  using (public.is_boss(auth.uid()));
