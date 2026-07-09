-- ============================================================
-- WurxOS v2 — Migration 235: attendance-linked incentive auto-fill.
--
-- Ops need (2026-07-09): an incentive item that is "about attendance"
-- (e.g. "Punctuality + Absences + General Review") should have its
-- Achieved value filled AUTOMATICALLY from the person's attendance —
-- not typed in by hand by the OL. The auto number must behave EXACTLY
-- like a hand-entered one for all downstream math (completion ≥90%,
-- earned/potential, verify, payout, rollover).
--
-- Design:
--   * No schema change. An attendance-linked item is just an existing
--     incentives/bonuses JSONB line item carrying a { "source":"attendance" }
--     flag (set via the "auto-fill from attendance" toggle in the editor).
--   * The number itself is the person's monthly attendance PERCENT, reused
--     verbatim from public.perf_attendance_score (the same figure the
--     Performance "attendance pillar" shows), so every surface agrees.
--   * The frontend calls this RPC at read time and writes the % into the
--     item's achievedValue (target is pinned to 100, so ≥90% attendance =
--     the item completes under the existing rule).
--
-- This RPC just batches perf_attendance_score over a set of users for one
-- month. Visibility mirrors the incentives read model: Boss/OL/developer
-- see everyone; anyone else sees only themselves + their direct reports.
--
-- Idempotent.
-- ============================================================

create or replace function public.incentive_attendance_pct(
  p_month    text,
  p_user_ids uuid[] default null
) returns table(user_id uuid, pct numeric)
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_uid  uuid := auth.uid();
  v_priv boolean;
begin
  v_priv := public.is_boss(v_uid)
    or exists (select 1 from public.profiles
                where id = v_uid and role in ('ol', 'developer'));

  return query
  select p.id, public.perf_attendance_score(p.id, p_month)
  from public.profiles p
  where (p_user_ids is null or p.id = any(p_user_ids))
    and (v_priv or p.id = v_uid or p.reports_to = v_uid);
end;
$$;

grant execute on function public.incentive_attendance_pct(text, uuid[]) to authenticated;
