-- ============================================================
-- WurxOS v2 — Migration 272: TL reporting accountability is OWNER-based.
--
-- Fix (found while reviewing the mig-271 report flow): reports.verified_by is
-- OVERWRITTEN to the actor on every verify, and when an OL verifies a report on
-- the TL's behalf (handleVerifyAsTl → updateReportStatus routes to verifyReport,
-- which sets verified_by = auth.uid() = the OL), the TL's own report is credited
-- to the OL. So counting a TL's reports / attributing a deduction by verified_by
-- would DROP those reports from the TL's N and mis-dock the OL.
--
-- The report's accountable TL is the brand's owner (brands.owner_id) — the same
-- "TL" the return notification already targets (reports_notify_on_status →
-- v_brand_owner). Re-key N and the deduction off brands.owner_id, pollution-proof.
--
-- Recreates only the 4 functions that resolved the TL by verified_by
-- (tl_reporting_score, tl_perf_preview, list_tl_reporting, tl_report_deduct).
-- get_performance_composite calls tl_reporting_score by name, so it picks up the
-- fix with no change. Safe to re-run.
-- ============================================================

-- reporting score: N = the TL's brand reports verified in the month
create or replace function public.tl_reporting_score(p_tl uuid, p_month text)
returns numeric language plpgsql security definer set search_path = public stable as $$
declare
  v_n     int;
  v_d     numeric;
  v_start timestamptz := (p_month || '-01')::timestamptz;
  v_end   timestamptz := ((p_month || '-01')::date + interval '1 month')::timestamptz;
begin
  select count(*) into v_n
    from public.reports r
    join public.brands b on b.id = r.brand_id
   where b.owner_id = p_tl and r.verified_at >= v_start and r.verified_at < v_end;
  if coalesce(v_n, 0) = 0 then return null; end if;

  select coalesce(sum(amount), 0) into v_d
    from public.tl_reporting_deductions where tl_id = p_tl and month = p_month;

  return greatest(0, (v_n::numeric - coalesce(v_d, 0))) / v_n * 100;
end;
$$;
revoke execute on function public.tl_reporting_score(uuid, text) from public, anon;
grant  execute on function public.tl_reporting_score(uuid, text) to authenticated, service_role;

create or replace function public.tl_perf_preview(p_tl uuid, p_month text)
returns table (team_score numeric, reporting_score numeric, reports_n int, deductions numeric, blended numeric)
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
   where b.owner_id = p_tl
     and r.verified_at >= (p_month || '-01')::timestamptz
     and r.verified_at <  ((p_month || '-01')::date + interval '1 month')::timestamptz;
  select coalesce(sum(amount), 0) into v_d from public.tl_reporting_deductions where tl_id = p_tl and month = p_month;
  v_report := public.tl_reporting_score(p_tl, p_month);

  if v_team is not null and v_report is not null then v_blend := round(0.6 * v_team + 0.4 * v_report);
  elsif v_team is not null then v_blend := round(v_team);
  elsif v_report is not null then v_blend := round(v_report);
  else v_blend := null; end if;

  return query select v_team, v_report, v_n, coalesce(v_d, 0), v_blend;
end;
$$;
revoke execute on function public.tl_perf_preview(uuid, text) from public, anon;
grant  execute on function public.tl_perf_preview(uuid, text) to authenticated, service_role;

create or replace function public.list_tl_reporting(p_month text)
returns table (tl_id uuid, reports_n int, deductions numeric, reporting_score numeric)
language plpgsql security definer set search_path = public stable as $$
declare
  v_uid uuid := auth.uid();
  v_svc boolean := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role'
                   or session_user in ('postgres', 'supabase_admin');
  v_is_mgr boolean;
begin
  v_is_mgr := v_svc or public.is_boss(v_uid)
    or exists (select 1 from public.profiles p where p.id = v_uid and p.role in ('ol','developer') and p.is_active = true);
  if not v_is_mgr then return; end if;
  return query
  select t.id,
         (select count(*)::int from public.reports r join public.brands b on b.id = r.brand_id
           where b.owner_id = t.id
             and r.verified_at >= (p_month || '-01')::timestamptz
             and r.verified_at <  ((p_month || '-01')::date + interval '1 month')::timestamptz),
         coalesce((select sum(amount) from public.tl_reporting_deductions d where d.tl_id = t.id and d.month = p_month), 0),
         public.tl_reporting_score(t.id, p_month)
    from public.profiles t
   where t.role = 'tl' and t.is_active = true and t.deleted_at is null;
end;
$$;
revoke execute on function public.list_tl_reporting(text) from public, anon;
grant  execute on function public.list_tl_reporting(text) to authenticated, service_role;

-- deduction: attribute to the report's BRAND OWNER (the accountable TL), month =
-- the report's verified-at month. Idempotency is intentional-none (each OL return
-- that docks points inserts one row).
create or replace function public.tl_report_deduct(p_report_id uuid, p_amount numeric default 1, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_tl uuid; v_vat timestamptz;
begin
  if not (public.is_boss(auth.uid())
          or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)) then
    raise exception 'only OL/Boss can set a reporting deduction';
  end if;
  if coalesce(p_amount, 0) <= 0 then return; end if;
  select b.owner_id, r.verified_at into v_tl, v_vat
    from public.reports r join public.brands b on b.id = r.brand_id
   where r.id = p_report_id;
  if v_tl is null then return; end if;   -- no brand owner → nobody accountable
  insert into public.tl_reporting_deductions (report_id, tl_id, month, amount, decided_by, note)
  values (p_report_id, v_tl, to_char(coalesce(v_vat, now()), 'YYYY-MM'), p_amount, auth.uid(), p_note);
end;
$$;
grant execute on function public.tl_report_deduct(uuid, numeric, text) to authenticated;
