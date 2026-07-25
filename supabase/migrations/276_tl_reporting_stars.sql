-- ============================================================
-- WurxOS v2 — Migration 276: OL weekly star rating for the TL's reporting.
--
-- The TL's reporting score (the 0.4 half of the TL performance pillar) was purely
-- objective: (verified reports − OL deductions) ÷ reports. Boss-confirmed
-- 2026-07-25: the OL also rates the TL 0–5 stars (half-steps) on that week's
-- reporting at the agenda meeting. The reporting score becomes a BLEND:
--
--   TL reporting = 0.6 × (OL star rating, monthly avg × 20)   [subjective]
--                + 0.4 × (return accountability (N−D)/N × 100) [objective, existing]
--
-- Null-handling: no stars this month → accountability only; no reports → stars
-- only; neither → null. The star rating (0–5) is stored per meeting
-- (agenda_meetings.tl_reporting_stars). get_performance_composite +
-- list_tl_reporting call tl_reporting_score by name, so the blend flows through
-- with no pillar-math change; the page reads reporting_score from the RPC.
-- Gated by the same TL trial switch (only affects the composite when ON).
--
-- Safe to re-run.
-- ============================================================

alter table public.agenda_meetings
  add column if not exists tl_reporting_stars numeric
    check (tl_reporting_stars >= 0 and tl_reporting_stars <= 5);

-- Subjective: the OL's star ratings for the TL's meetings this month → 0–100.
create or replace function public.tl_report_stars_score(p_tl uuid, p_month text)
returns numeric language plpgsql security definer set search_path = public stable as $$
declare v_avg numeric;
begin
  select avg(tl_reporting_stars) into v_avg
    from public.agenda_meetings
   where tl_id = p_tl and tl_reporting_stars is not null
     and to_char(meeting_date, 'YYYY-MM') = p_month;
  if v_avg is null then return null; end if;
  return least(100, greatest(0, v_avg * 20));   -- 0–5 stars → 0–100
end;
$$;
revoke execute on function public.tl_report_stars_score(uuid, text) from public, anon;
grant  execute on function public.tl_report_stars_score(uuid, text) to authenticated, service_role;

-- Objective: (verified brand reports − deductions) ÷ reports × 100 (the previous
-- tl_reporting_score body from mig 273 — Karachi window + deduction D-join).
create or replace function public.tl_report_accountability(p_tl uuid, p_month text)
returns numeric language plpgsql security definer set search_path = public stable as $$
declare
  v_n     int;
  v_d     numeric;
  v_start timestamptz := (p_month || '-01')::timestamp at time zone 'Asia/Karachi';
  v_end   timestamptz := ((p_month || '-01')::date + interval '1 month')::timestamp at time zone 'Asia/Karachi';
begin
  select count(*) into v_n
    from public.reports r join public.brands b on b.id = r.brand_id
   where b.owner_id = p_tl and r.verified_at >= v_start and r.verified_at < v_end;
  if coalesce(v_n, 0) = 0 then return null; end if;
  select coalesce(sum(d.amount), 0) into v_d
    from public.tl_reporting_deductions d
    join public.reports r on r.id = d.report_id
    join public.brands b on b.id = r.brand_id
   where b.owner_id = p_tl and r.verified_at >= v_start and r.verified_at < v_end;
  return greatest(0, (v_n::numeric - coalesce(v_d, 0))) / v_n * 100;
end;
$$;
revoke execute on function public.tl_report_accountability(uuid, text) from public, anon;
grant  execute on function public.tl_report_accountability(uuid, text) to authenticated, service_role;

-- The blend. Recreated in place (same signature) so callers pick it up unchanged.
create or replace function public.tl_reporting_score(p_tl uuid, p_month text)
returns numeric language plpgsql security definer set search_path = public stable as $$
declare v_star numeric; v_acct numeric;
begin
  v_star := public.tl_report_stars_score(p_tl, p_month);
  v_acct := public.tl_report_accountability(p_tl, p_month);
  if v_star is not null and v_acct is not null then return 0.6 * v_star + 0.4 * v_acct;
  elsif v_star is not null then return v_star;
  elsif v_acct is not null then return v_acct;
  else return null; end if;
end;
$$;
revoke execute on function public.tl_reporting_score(uuid, text) from public, anon;
grant  execute on function public.tl_reporting_score(uuid, text) to authenticated, service_role;

-- Preview expanded with the star + accountability components for the breakdown UI.
drop function if exists public.tl_perf_preview(uuid, text);
create function public.tl_perf_preview(p_tl uuid, p_month text)
returns table (team_score numeric, reporting_score numeric, reports_n int, deductions numeric,
               blended numeric, star_avg numeric, star_score numeric, accountability numeric)
language plpgsql security definer set search_path = public stable as $$
declare
  v_uid    uuid := auth.uid();
  v_svc    boolean := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role'
                      or session_user in ('postgres', 'supabase_admin');
  v_team   numeric;
  v_report numeric;
  v_n      int;
  v_d      numeric;
  v_blend  numeric;
  v_savg   numeric;
  v_sscore numeric;
  v_acct   numeric;
  v_start  timestamptz := (p_month || '-01')::timestamp at time zone 'Asia/Karachi';
  v_end    timestamptz := ((p_month || '-01')::date + interval '1 month')::timestamp at time zone 'Asia/Karachi';
begin
  if not (v_svc or public.is_boss(v_uid) or v_uid = p_tl
          or exists (select 1 from public.profiles p where p.id = v_uid and p.role in ('ol','developer') and p.is_active = true)
          or exists (select 1 from public.profiles t where t.id = p_tl and t.reports_to = v_uid)) then
    return;
  end if;

  select avg(c.composite_score) into v_team
    from public.profiles a
    cross join lateral public.get_performance_composite(a.id, p_month) c
   where a.reports_to = p_tl and a.role = 'apc' and a.is_active = true and a.deleted_at is null
     and c.composite_score is not null;

  select count(*) into v_n
    from public.reports r join public.brands b on b.id = r.brand_id
   where b.owner_id = p_tl and r.verified_at >= v_start and r.verified_at < v_end;
  select coalesce(sum(d.amount), 0) into v_d
    from public.tl_reporting_deductions d
    join public.reports r on r.id = d.report_id
    join public.brands b on b.id = r.brand_id
   where b.owner_id = p_tl and r.verified_at >= v_start and r.verified_at < v_end;

  select avg(tl_reporting_stars) into v_savg
    from public.agenda_meetings
   where tl_id = p_tl and tl_reporting_stars is not null and to_char(meeting_date, 'YYYY-MM') = p_month;
  v_sscore := public.tl_report_stars_score(p_tl, p_month);
  v_acct   := public.tl_report_accountability(p_tl, p_month);
  v_report := public.tl_reporting_score(p_tl, p_month);

  if v_team is not null and v_report is not null then v_blend := round(0.6 * v_team + 0.4 * v_report);
  elsif v_team is not null then v_blend := round(v_team);
  elsif v_report is not null then v_blend := round(v_report);
  else v_blend := null; end if;

  return query select v_team, v_report, v_n, coalesce(v_d, 0), v_blend, v_savg, v_sscore, v_acct;
end;
$$;
revoke execute on function public.tl_perf_preview(uuid, text) from public, anon;
grant  execute on function public.tl_perf_preview(uuid, text) to authenticated, service_role;
