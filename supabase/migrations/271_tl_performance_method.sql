-- ============================================================
-- WurxOS v2 — Migration 271: Team-Lead performance method.
--
-- Replaces the OL's hand-rated 5-metric PERFORMANCE PILLAR for TLs with an
-- objective blend (Boss-confirmed 2026-07-25):
--   TL performance pillar = 0.6 × TEAM SCORE + 0.4 × REPORTING SCORE
--     • TEAM SCORE     = average of the TL's APCs' COMPOSITE scores (skip unrated)
--     • REPORTING SCORE= (reports the TL verified this month − deductions) ÷ reports × 100
--       deductions: when the OL returns a VERIFIED report to the TL, the OL may
--       dock points (default 1). Cumulative over the month.
--
-- "Pillar swap only" — attendance / incentives / flags / the composite weights /
-- the incentive-verify gate are all UNCHANGED. Only the perf pillar's SOURCE
-- changes, and only for TLs.
--
-- SAFETY: gated by a Boss trial switch (tl_perf_method_enabled, default OFF) AND
-- floored at tl_perf_since (2026-08-01) so — even when ON — closed/paid months
-- keep the old method (the mig-269/F2 lesson). Deploy is switch OFF: TLs keep the
-- old OL rating; the new blend is preview-only until the Boss flips it ON.
--
-- Computed ON-READ inside get_performance_composite (the team score depends on the
-- APCs' live composites, so there is nothing sensible to pre-store). The page
-- mirrors this blend in JS; composite-parity.mjs must keep holding.
--
-- Safe to re-run.
-- ============================================================

-- ── config: TL trial switch + launch floor ───────────────────────────
alter table public.performance_config
  add column if not exists tl_perf_method_enabled boolean not null default false,
  add column if not exists tl_perf_since           date    not null default date '2026-08-01';

-- ── reporting deductions (one row per OL→TL return that docks points) ─
create table if not exists public.tl_reporting_deductions (
  id          uuid primary key default gen_random_uuid(),
  report_id   uuid references public.reports(id) on delete cascade,
  tl_id       uuid not null references public.profiles(id) on delete cascade,
  month       text not null,                         -- 'YYYY-MM' = the report's verified-at month
  amount      numeric not null default 1 check (amount >= 0),
  decided_by  uuid references public.profiles(id) on delete set null,
  note        text,
  created_at  timestamptz not null default now()
);
create index if not exists tl_ded_tl_month_idx on public.tl_reporting_deductions(tl_id, month);
create index if not exists tl_ded_report_idx    on public.tl_reporting_deductions(report_id);

alter table public.tl_reporting_deductions enable row level security;

-- SELECT: boss / active ol|developer / the TL themselves.
drop policy if exists "tl_ded_select" on public.tl_reporting_deductions;
create policy "tl_ded_select" on public.tl_reporting_deductions for select using (
  public.is_boss(auth.uid())
  or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
  or tl_id = auth.uid()
);
-- No client writes — rows come only through the SECURITY DEFINER RPCs below.
drop policy if exists "tl_ded_no_write" on public.tl_reporting_deductions;
create policy "tl_ded_no_write" on public.tl_reporting_deductions for all using (false) with check (false);

-- ── reporting score: (N verified − D deductions) / N × 100, null if N=0 ─
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
   where r.verified_by = p_tl and r.verified_at >= v_start and r.verified_at < v_end;
  if coalesce(v_n, 0) = 0 then return null; end if;

  select coalesce(sum(amount), 0) into v_d
    from public.tl_reporting_deductions where tl_id = p_tl and month = p_month;

  return greatest(0, (v_n::numeric - coalesce(v_d, 0))) / v_n * 100;
end;
$$;
revoke execute on function public.tl_reporting_score(uuid, text) from public, anon;
grant  execute on function public.tl_reporting_score(uuid, text) to authenticated, service_role;

-- ── preview: the TL blend components (for the breakdown modal + JS preview) ─
-- Visibility-gated (boss / self / ol|dev / direct manager), same predicate as the
-- composite. Computes the new-method value regardless of the switch (for preview).
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

  select count(*) into v_n from public.reports r
   where r.verified_by = p_tl
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

-- ── bulk reporting for the page's TL rows: {tl_id, n, d, score} ──────
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
  if not v_is_mgr then return; end if;   -- only boss/ol see the whole TL set
  return query
  select t.id,
         (select count(*)::int from public.reports r
           where r.verified_by = t.id
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

-- ── OL sets a reporting deduction when returning a verified report ───
create or replace function public.tl_report_deduct(p_report_id uuid, p_amount numeric default 1, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_tl uuid; v_vat timestamptz;
begin
  if not (public.is_boss(auth.uid())
          or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)) then
    raise exception 'only OL/Boss can set a reporting deduction';
  end if;
  if coalesce(p_amount, 0) <= 0 then return; end if;             -- 0 = no deduction
  select verified_by, verified_at into v_tl, v_vat from public.reports where id = p_report_id;
  if v_tl is null then return; end if;                           -- no verifier → nobody to dock
  insert into public.tl_reporting_deductions (report_id, tl_id, month, amount, decided_by, note)
  values (p_report_id, v_tl, to_char(coalesce(v_vat, now()), 'YYYY-MM'), p_amount, auth.uid(), p_note);
end;
$$;
grant execute on function public.tl_report_deduct(uuid, numeric, text) to authenticated;

-- Undo a deduction (OL/Boss correction).
create or replace function public.tl_report_deduct_remove(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (public.is_boss(auth.uid())
          or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)) then
    raise exception 'only OL/Boss can remove a reporting deduction';
  end if;
  delete from public.tl_reporting_deductions where id = p_id;
end;
$$;
grant execute on function public.tl_report_deduct_remove(uuid) to authenticated;

-- ── Boss trial switch (no backfill — the method is computed on-read) ──
create or replace function public.set_tl_perf_method_enabled(p_enabled boolean)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if not public.is_boss(auth.uid()) then raise exception 'only the Boss can change the TL performance method'; end if;
  update public.performance_config set tl_perf_method_enabled = p_enabled, updated_by = auth.uid(), updated_at = now() where id = 1;
  return p_enabled;
end;
$$;
grant execute on function public.set_tl_perf_method_enabled(boolean) to authenticated;

-- ── the composite: branch the PERF PILLAR for TLs (gated + floored) ──
-- Recreated verbatim from mig 257, changing ONLY how v_perf is derived: for a TL,
-- when the switch is ON and the month is >= the launch floor, v_perf is the
-- team/reporting blend; otherwise (and for everyone else) it stays overall_score.
create or replace function public.get_performance_composite(p_user uuid, p_month text)
returns table (
  user_id uuid, month text, performance_score numeric, incentives_score numeric,
  attendance_score numeric, flags_score numeric, composite_score numeric, level text, warning_count int
)
language plpgsql security definer set search_path = public stable as $$
#variable_conflict use_column
declare
  v_uid       uuid := auth.uid();
  v_svc       boolean := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role'
                         or session_user in ('postgres', 'supabase_admin');
  v_can_see   boolean;
  v_cfg       public.performance_config%rowtype;
  v_role      text;
  v_team      numeric;
  v_report    numeric;
  v_perf_raw  numeric;
  v_perf      numeric;
  v_inc       numeric;
  v_att       numeric;
  v_flg       numeric;
  v_has_inc   boolean := false;
  v_verified  boolean;
  v_pending   boolean := false;
  v_num       numeric := 0;
  v_den       numeric := 0;
  v_composite numeric;
  v_level     text;
  v_warnings  int;
begin
  v_can_see := v_svc or public.is_boss(v_uid) or v_uid = p_user
    or exists (select 1 from public.profiles p where p.id = v_uid and p.role in ('ol','developer') and p.is_active = true and p.deleted_at is null)
    or exists (select 1 from public.profiles t where t.id = p_user and t.reports_to = v_uid);
  if (v_uid is null and not v_svc) or not v_can_see then return; end if;

  select * into v_cfg from public.performance_config where id = 1;
  select role into v_role from public.profiles where id = p_user;

  -- PERFORMANCE PILLAR
  if v_role = 'tl' and coalesce(v_cfg.tl_perf_method_enabled, false)
     and p_month >= to_char(coalesce(v_cfg.tl_perf_since, date '2026-08-01'), 'YYYY-MM') then
    -- team score = average of the TL's APCs' composites (skip unrated)
    select avg(c.composite_score) into v_team
      from public.profiles a
      cross join lateral public.get_performance_composite(a.id, p_month) c
     where a.reports_to = p_user and a.role = 'apc' and a.is_active = true and a.deleted_at is null
       and c.composite_score is not null;
    v_report := public.tl_reporting_score(p_user, p_month);
    if v_team is not null and v_report is not null then v_perf := round(0.6 * v_team + 0.4 * v_report);
    elsif v_team is not null then v_perf := round(v_team);
    elsif v_report is not null then v_perf := round(v_report);
    else v_perf := null; end if;
    if v_perf is not null then v_perf := least(100, greatest(0, v_perf)); end if;
  else
    select pr.overall_score into v_perf_raw from public.performance_ratings pr
     where pr.user_id = p_user and pr.month = p_month;
    if v_perf_raw is null then v_perf := null; else v_perf := least(100, greatest(0, round(v_perf_raw))); end if;
  end if;

  select
    (coalesce(jsonb_array_length(i.incentives), 0) + coalesce(jsonb_array_length(i.bonuses), 0)) >= 1,
    coalesce(i.verified, false)
    into v_has_inc, v_verified
    from public.incentives i where i.user_id = p_user and i.month = p_month;
  v_has_inc := coalesce(v_has_inc, false);
  v_pending := v_has_inc and not coalesce(v_verified, false);

  if v_has_inc then v_inc := least(100, greatest(0, coalesce(public.perf_incentives_score(p_user, p_month), 0)));
  else v_inc := null; end if;
  v_att := least(100, greatest(0, coalesce(public.perf_attendance_score(p_user, p_month), 0)));
  v_flg := least(100, greatest(0, coalesce(public.perf_flags_score(p_user, p_month), 0)));

  if v_perf is null then
    v_composite := null; v_level := public.perf_level(null);
  elsif v_pending then
    v_composite := null; v_level := 'pending_verification';
  else
    v_num := v_perf * v_cfg.weight_performance; v_den := v_cfg.weight_performance;
    if v_inc is not null then v_num := v_num + v_inc * v_cfg.weight_incentives; v_den := v_den + v_cfg.weight_incentives; end if;
    v_num := v_num + v_att * v_cfg.weight_attendance; v_den := v_den + v_cfg.weight_attendance;
    v_num := v_num + v_flg * v_cfg.weight_flags;      v_den := v_den + v_cfg.weight_flags;
    if v_den > 0 then v_composite := round(least(100, greatest(0, v_num / v_den))); else v_composite := 0; end if;
    v_level := public.perf_level(v_composite);
  end if;

  select count(*) into v_warnings from public.performance_warnings pw where pw.user_id = p_user;

  return query select p_user, p_month, v_perf, v_inc, v_att, v_flg, v_composite, v_level, v_warnings;
end;
$$;
revoke execute on function public.get_performance_composite(uuid, text) from public, anon;
grant  execute on function public.get_performance_composite(uuid, text) to authenticated, service_role;
