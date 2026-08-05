-- ============================================================
-- WurxOS v2 — Migration 303: per-report reporting stars (perf restructure #1).
--
-- Boss-confirmed 2026-08-05 restructure of how "external reporting" is scored.
-- External reporting is now judged PER REPORT, at the workflow step the reviewer
-- already performs, replacing the OL's agenda-meeting star + the OL's 0–90 APC
-- reporting slider:
--
--   • The TL rates each of THEIR APC's reports 0–5★ when VERIFYING it  → feeds the
--     APC's external-report score (author_id).          [reports.apc_stars]
--   • The OL rates each TL's report 0–5★ when APPROVING it            → feeds the
--     TL's reporting score (brand owner_id).             [reports.tl_stars]
--
-- This migration adds the two star columns + gated write RPCs, and RE-POINTS the
-- TL star source from agenda_meetings.tl_reporting_stars (mig 276) to
-- reports.tl_stars. The APC-side scoring + the composite APC branch land in
-- mig 304. Stars are captured regardless of any switch; they only reach a
-- composite through the (switch+floor-gated) blends.
--
-- Windowing mirrors mig 273/276: monthly bucket = the report's verified_at in
-- [month, next month) Asia/Karachi, joined on brands.owner_id for the TL (the
-- accountable party — verified_by is overwritten on every verify) and on
-- author_id for the APC. Half-star (0.5) ratings allowed; avg × 20 → 0–100.
--
-- Safe to re-run.
-- ============================================================

-- ── 1. star columns on reports ───────────────────────────────────────
alter table public.reports
  add column if not exists apc_stars    numeric check (apc_stars >= 0 and apc_stars <= 5),
  add column if not exists apc_stars_by  uuid references public.profiles(id) on delete set null,
  add column if not exists tl_stars     numeric check (tl_stars  >= 0 and tl_stars  <= 5),
  add column if not exists tl_stars_by   uuid references public.profiles(id) on delete set null;

-- ── 2. write RPCs (gated). The reports UPDATE RLS is ROW-level (author /
--       brand-owner) and can't restrict a single column, and a column-level
--       REVOKE is ineffective because Supabase grants `authenticated` TABLE-level
--       UPDATE (which dominates column grants). So the stars go through these
--       SECURITY DEFINER RPCs, and a BEFORE-UPDATE guard trigger (section 4)
--       blocks any OTHER writer from changing them via a direct PATCH. ─

-- The TL (brand owner) rates their APC's report at verify. Boss/OL/dev may also
-- set it (admin override). Only meaningful once the report is verified — a draft
-- has no reviewed quality yet.
create or replace function public.report_rate_apc(p_report_id uuid, p_stars numeric)
returns void language plpgsql security definer set search_path = public as $$
declare v_brand uuid; v_status text;
begin
  select brand_id, status into v_brand, v_status from public.reports where id = p_report_id;
  if v_brand is null then return; end if;
  if not (public.is_boss(auth.uid())
          or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
          or exists (select 1 from public.brands b where b.id = v_brand and b.owner_id = auth.uid())) then
    raise exception 'only the brand owner (TL) or OL/Boss can rate this report';
  end if;
  if v_status not in ('verified','approved') then
    raise exception 'a report can only be rated once it is verified';
  end if;
  update public.reports
     set apc_stars = least(5, greatest(0, p_stars)), apc_stars_by = auth.uid()
   where id = p_report_id;
end;
$$;
revoke execute on function public.report_rate_apc(uuid, numeric) from public, anon;
grant  execute on function public.report_rate_apc(uuid, numeric) to authenticated;

-- The OL rates the TL's report at approve. Boss/dev override. Only once approved.
create or replace function public.report_rate_tl(p_report_id uuid, p_stars numeric)
returns void language plpgsql security definer set search_path = public as $$
declare v_status text;
begin
  select status into v_status from public.reports where id = p_report_id;
  if v_status is null then return; end if;
  if not (public.is_boss(auth.uid())
          or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)) then
    raise exception 'only OL/Boss can rate a Team Lead''s report';
  end if;
  if v_status <> 'approved' then
    raise exception 'a Team Lead report can only be rated once it is approved';
  end if;
  update public.reports
     set tl_stars = least(5, greatest(0, p_stars)), tl_stars_by = auth.uid()
   where id = p_report_id;
end;
$$;
revoke execute on function public.report_rate_tl(uuid, numeric) from public, anon;
grant  execute on function public.report_rate_tl(uuid, numeric) to authenticated;

-- ── 3. RE-POINT the TL star source: agenda_meetings → reports.tl_stars ─
-- The monthly TL star score is now the average of the OL's per-report approve
-- stars over the TL's brand reports VERIFIED in the month (same set/window the
-- accountability half uses, mig 276), × 20. Null when no rated report.
create or replace function public.tl_report_stars_score(p_tl uuid, p_month text)
returns numeric language plpgsql security definer set search_path = public stable as $$
declare
  v_avg   numeric;
  v_start timestamptz := (p_month || '-01')::timestamp at time zone 'Asia/Karachi';
  v_end   timestamptz := ((p_month || '-01')::date + interval '1 month')::timestamp at time zone 'Asia/Karachi';
begin
  select avg(r.tl_stars) into v_avg
    from public.reports r
    join public.brands b on b.id = r.brand_id
   where b.owner_id = p_tl and r.tl_stars is not null
     and r.verified_at >= v_start and r.verified_at < v_end;
  if v_avg is null then return null; end if;
  return least(100, greatest(0, v_avg * 20));   -- 0–5 stars → 0–100
end;
$$;
revoke execute on function public.tl_report_stars_score(uuid, text) from public, anon, authenticated;
grant  execute on function public.tl_report_stars_score(uuid, text) to service_role;

-- ── 4. GUARD: the star columns feed salary, so they may be written ONLY by the
--       SECURITY DEFINER rate RPCs above (which run as the table owner) or by
--       service_role — never by a direct author/brand-owner PATCH. This trigger
--       is SECURITY INVOKER (no `security definer`) so current_user reflects the
--       REAL caller: `postgres` when inside a definer RPC, the JWT role
--       (`authenticated`) on a direct PostgREST UPDATE. Ordinary report writes
--       (draft save, verify, approve, return) never touch these columns, so the
--       `is distinct from` guard is a no-op for them.
create or replace function public.reports_guard_stars()
returns trigger language plpgsql set search_path = public as $$
begin
  -- Block only the PostgREST JWT roles (a direct client PATCH always runs as
  -- `authenticated`/`anon`). The definer rate RPCs run as the function owner
  -- (never a JWT role), so they pass; this is robust to whatever role owns the
  -- migration objects, unlike an admin allow-list.
  if (new.apc_stars    is distinct from old.apc_stars
   or new.apc_stars_by is distinct from old.apc_stars_by
   or new.tl_stars     is distinct from old.tl_stars
   or new.tl_stars_by  is distinct from old.tl_stars_by)
   and current_user in ('authenticated', 'anon') then
    raise exception 'report reporting stars can only be set via report_rate_apc / report_rate_tl';
  end if;
  return new;
end;
$$;
drop trigger if exists reports_guard_stars_trg on public.reports;
create trigger reports_guard_stars_trg
  before update on public.reports
  for each row execute function public.reports_guard_stars();

-- ── 5. PRESERVE the OL's already-entered stars for the live month(s). The OL
--       rated TLs 0–5★ per agenda meeting under the old method (August went live
--       2026-08-02). Since the score now reads reports.tl_stars, carry each TL's
--       per-month meeting-star AVERAGE onto their reports VERIFIED in that month
--       so tl_report_stars_score keeps its value instead of resetting to null.
--       Only fills reports that don't already carry a star → idempotent. The guard
--       trigger passes because the migration runs as the table owner, not a JWT role.
do $$
declare r record; v_floor text; v_start timestamptz; v_end timestamptz;
begin
  select to_char(coalesce(tl_perf_since, date '2026-08-01'), 'YYYY-MM') into v_floor
    from public.performance_config where id = 1;
  for r in
    select m.tl_id, to_char(m.meeting_date, 'YYYY-MM') as ym,
           round(avg(m.tl_reporting_stars), 2) as avg_star
      from public.agenda_meetings m
     where m.tl_reporting_stars is not null
       and to_char(m.meeting_date, 'YYYY-MM') >= coalesce(v_floor, '2026-08')
     group by m.tl_id, to_char(m.meeting_date, 'YYYY-MM')
  loop
    v_start := (r.ym || '-01')::timestamp at time zone 'Asia/Karachi';
    v_end   := ((r.ym || '-01')::date + interval '1 month')::timestamp at time zone 'Asia/Karachi';
    update public.reports rep
       set tl_stars = r.avg_star
      from public.brands b
     where b.id = rep.brand_id
       and b.owner_id = r.tl_id
       and rep.verified_at >= v_start and rep.verified_at < v_end
       and rep.tl_stars is null;
  end loop;
end $$;
