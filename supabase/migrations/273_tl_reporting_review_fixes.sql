-- ============================================================
-- WurxOS v2 — Migration 273: TL reporting review fixes (pre-go-live).
--
-- Adversarial review of migs 271/272 confirmed two money-critical defects in the
-- reporting pillar (both gated behind the default-OFF switch, so safe while OFF):
--
--  H1 TIMEZONE: the month windows used bare `(p_month||'-01')::timestamptz`,
--     which resolve in the SESSION zone (UTC for PostgREST/service_role), not
--     Asia/Karachi. Every other money-critical month boundary in this codebase
--     anchors to Karachi (migs 218/252/256). So N/D landed ~5h off the app's
--     month and differed between connection contexts. Anchor to Asia/Karachi.
--
--  H2 CROSS-MONTH RE-VERIFY: N counted a report by its CURRENT verified_at, but D
--     summed deductions by a `month` text column frozen at deduct-time. A report
--     verified in M, docked, then re-verified in M+1 (verifyReport overwrites
--     verified_at) left N[M] while its deduction stayed in M — erasing M's
--     penalty and rewarding the re-verified report in M+1. Fix: compute D by
--     JOINing deductions→reports→brands and filtering on the report's live
--     verified_at within the SAME window as N, so each deduction travels with
--     its report. (The stored `month` column becomes advisory.)
--
-- Also L: revoke the three write RPCs from public/anon (they only grant to
-- authenticated and fail-closed on their is_boss/OL gate, but match the read
-- RPCs' revoke-then-grant hygiene).
--
-- get_performance_composite is unchanged — it calls tl_reporting_score by name
-- and picks up the fix. Safe to re-run.
-- ============================================================

create or replace function public.tl_reporting_score(p_tl uuid, p_month text)
returns numeric language plpgsql security definer set search_path = public stable as $$
declare
  v_n     int;
  v_d     numeric;
  v_start timestamptz := (p_month || '-01')::timestamp at time zone 'Asia/Karachi';
  v_end   timestamptz := ((p_month || '-01')::date + interval '1 month')::timestamp at time zone 'Asia/Karachi';
begin
  select count(*) into v_n
    from public.reports r
    join public.brands b on b.id = r.brand_id
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
  v_start  timestamptz := (p_month || '-01')::timestamp at time zone 'Asia/Karachi';
  v_end    timestamptz := ((p_month || '-01')::date + interval '1 month')::timestamp at time zone 'Asia/Karachi';
begin
  v_is_mgr := v_svc or public.is_boss(v_uid)
    or exists (select 1 from public.profiles p where p.id = v_uid and p.role in ('ol','developer') and p.is_active = true);
  if not v_is_mgr then return; end if;
  return query
  select t.id,
         (select count(*)::int from public.reports r join public.brands b on b.id = r.brand_id
           where b.owner_id = t.id and r.verified_at >= v_start and r.verified_at < v_end),
         coalesce((select sum(d.amount) from public.tl_reporting_deductions d
                    join public.reports r on r.id = d.report_id
                    join public.brands b on b.id = r.brand_id
                   where b.owner_id = t.id and r.verified_at >= v_start and r.verified_at < v_end), 0),
         public.tl_reporting_score(t.id, p_month)
    from public.profiles t
   where t.role = 'tl' and t.is_active = true and t.deleted_at is null;
end;
$$;
revoke execute on function public.list_tl_reporting(text) from public, anon;
grant  execute on function public.list_tl_reporting(text) to authenticated, service_role;

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
  if v_tl is null then return; end if;
  -- month is now advisory (D is computed by joining to the report's verified_at);
  -- still store it Karachi-anchored for readability.
  insert into public.tl_reporting_deductions (report_id, tl_id, month, amount, decided_by, note)
  values (p_report_id, v_tl, to_char(coalesce(v_vat, now()) at time zone 'Asia/Karachi', 'YYYY-MM'), p_amount, auth.uid(), p_note);
end;
$$;
revoke execute on function public.tl_report_deduct(uuid, numeric, text) from public, anon;
grant  execute on function public.tl_report_deduct(uuid, numeric, text) to authenticated;

-- revoke hygiene for the two remaining write RPCs (mig 271).
revoke execute on function public.tl_report_deduct_remove(uuid) from public, anon;
grant  execute on function public.tl_report_deduct_remove(uuid) to authenticated;
revoke execute on function public.set_tl_perf_method_enabled(boolean) from public, anon;
grant  execute on function public.set_tl_perf_method_enabled(boolean) to authenticated;
