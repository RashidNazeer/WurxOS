-- ============================================================
-- WurxOS v2 — Migration 322: an explicit "Share with client" tick per report.
--
-- BEFORE: the client portal (get_client_access) showed a client EVERY report
-- on their brands whose status was 'approved'. Approval is an internal quality
-- gate, so approving a report silently published it. There was no way for an
-- OL to approve something for internal purposes and keep it back, and no way
-- to withdraw one report without un-approving it (which would distort the
-- performance figures that read approval state).
--
-- AFTER: a report reaches a client only when BOTH are true —
--        status = 'approved'  AND  shared_with_client = true.
-- Approval stays the quality gate; the tick is the publishing decision, and
-- they are now separate acts.
--
-- THE INVARIANT, enforced three ways because it is a data-exposure rule and
-- the UI is the weakest of the three:
--   1. CHECK constraint  — an unapproved report can never carry the tick,
--                          whoever writes it and by whatever route.
--   2. BEFORE trigger    — if a report leaves 'approved' (returned for
--                          revision, reopened) the tick is dropped
--                          automatically. Without this the CHECK would make
--                          returning a shared report fail outright, and worse,
--                          a report could otherwise sit shared while being
--                          rewritten.
--   3. Role trigger      — only Boss/OL may change the tick. The reports
--                          UPDATE policy is deliberately broad (authors and
--                          brand-owner TLs can write rows), and RLS cannot
--                          restrict a single column, so this is the only place
--                          that distinction can live.
--
-- Idempotent.
-- ============================================================

-- ── 1. The column ────────────────────────────────────────────────────
alter table public.reports
  add column if not exists shared_with_client boolean not null default false;

comment on column public.reports.shared_with_client is
  'OL/Boss decision to publish this report to the client portal. Meaningless unless status = approved; the client sees a report only when both hold.';

-- Partial index: the client portal only ever asks for the ticked ones.
create index if not exists reports_shared_with_client_idx
  on public.reports (brand_id, type, period_start desc)
  where shared_with_client = true;

-- ── 2. CHECK — the tick cannot exist without approval ────────────────
-- Added NOT VALID first so the statement cannot fail on pre-existing rows,
-- then validated once the backfill below has made every row conform.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.reports'::regclass and conname = 'reports_share_requires_approved'
  ) then
    alter table public.reports
      add constraint reports_share_requires_approved
      check (shared_with_client = false or status = 'approved') not valid;
  end if;
end;
$$;

-- ── 3. Drop the tick automatically when a report leaves 'approved' ───
create or replace function public.reports_unshare_on_unapprove()
returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from 'approved' then
    new.shared_with_client := false;
  end if;
  return new;
end;
$$;

drop trigger if exists reports_unshare_on_unapprove_trg on public.reports;
create trigger reports_unshare_on_unapprove_trg
  before insert or update on public.reports
  for each row execute function public.reports_unshare_on_unapprove();

-- ── 4. Only Boss/OL may move the tick ────────────────────────────────
-- It objects ONLY when the status is staying on 'approved', because that is
-- the only case where moving the tick is a deliberate publishing decision. An
-- automatic unshare caused by a status change must not be mistaken for someone
-- unpublishing, or returning a report for revision would fail for the very
-- people (authors, brand-owner TLs) who are supposed to be able to do it.
--
-- That condition is why trigger ORDER does not matter here. Postgres fires
-- BEFORE triggers alphabetically, so this one ("guard") actually runs before
-- "unshare" — but the two can never both apply to the same row, since one acts
-- only while status stays 'approved' and the other only when it does not.
create or replace function public.reports_guard_share_flag()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if tg_op = 'UPDATE'
     and new.shared_with_client is distinct from old.shared_with_client
     and new.status = 'approved' and old.status = 'approved' then
    -- auth.uid() is null for the service role / migrations, which must stay
    -- able to run backfills.
    if v_uid is not null
       and not public.is_boss(v_uid)
       and not exists (
         select 1 from public.profiles p
         where p.id = v_uid and p.role in ('ol', 'developer') and p.is_active = true
       ) then
      raise exception 'only an Operations Lead or the Boss can change whether a report is shared with the client';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists reports_guard_share_flag_trg on public.reports;
create trigger reports_guard_share_flag_trg
  before update on public.reports
  for each row execute function public.reports_guard_share_flag();

-- ── 5. Backfill — every currently approved report becomes shared ─────
-- Explicitly requested: today's behaviour is "approved means visible", so
-- ticking them all keeps every client seeing exactly what they see now. The
-- tick only starts changing anything from here on.
-- WHERE clause is mandatory (safeupdate rejects unqualified UPDATE, mig 319).
update public.reports
   set shared_with_client = true
 where status = 'approved'
   and shared_with_client = false;

alter table public.reports validate constraint reports_share_requires_approved;

-- ── 6. The client portal now requires the tick ───────────────────────
-- Body is mig 280's VERBATIM apart from the two `shared_with_client` clauses.
create or replace function public.get_client_access(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_access    public.client_access%rowtype;
  v_brands    jsonb;
  v_reports   jsonb;
  v_gmv       jsonb;
  v_sections  jsonb;
  v_values    jsonb;
  v_resources jsonb;
begin
  select * into v_access from public.client_access where token = p_token;
  if not found                          then raise exception 'access_not_found' using errcode = 'P0002'; end if;
  if v_access.active = false            then raise exception 'access_disabled'  using errcode = 'P0003'; end if;
  if v_access.revoked_at is not null    then raise exception 'access_revoked'   using errcode = 'P0003'; end if;
  if v_access.expires_at is not null and v_access.expires_at < now()
                                         then raise exception 'access_expired'  using errcode = 'P0004'; end if;

  -- Brands
  select coalesce(jsonb_agg(
    jsonb_build_object('id', b.id, 'brand_name', b.brand_name, 'logo_url', b.logo_url, 'currency', b.currency)
    order by b.brand_name
  ), '[]'::jsonb)
    into v_brands
  from public.brands b
  where b.id = any(v_access.brand_ids);

  -- Reports — approved AND ticked for sharing + permitted brands/types
  if v_access.share_types && array['weekly','biweekly','monthly'] then
    select coalesce(jsonb_agg(row_to_json(t) order by t.period_start desc), '[]'::jsonb)
      into v_reports
    from (
      select r.id, r.brand_id, r.type,
             r.period_start, r.period_end, r.period_label, r.period_year, r.period_month,
             r.status, r.data, r.updated_at, r.created_at,
             p.display_name as author_name,
             b.brand_name, b.logo_url, b.currency as brand_currency
      from public.reports r
      left join public.profiles p on p.id = r.author_id
      left join public.brands   b on b.id = r.brand_id
      where r.brand_id = any(v_access.brand_ids)
        and r.status = 'approved'
        and r.shared_with_client = true
        and r.type = any(v_access.share_types)
    ) t;
  else
    v_reports := '[]'::jsonb;
  end if;

  -- GMV Max
  if 'gmvMax' = any(v_access.share_types) then
    select coalesce(jsonb_agg(row_to_json(g) order by g.period_start desc), '[]'::jsonb)
      into v_gmv
    from (
      select gm.*, b.brand_name as brand_name_lookup, b.logo_url, b.currency as brand_currency
      from public.gmv_max_reports gm
      left join public.brands b on b.id = gm.brand_id
      where gm.brand_id = any(v_access.brand_ids)
    ) g;
  else
    v_gmv := '[]'::jsonb;
  end if;

  -- Section templates — one entry per brand carrying its jsonb array.
  select coalesce(jsonb_agg(
    jsonb_build_object('brand_id', brs.brand_id, 'sections', coalesce(brs.sections, '[]'::jsonb))
  ), '[]'::jsonb)
    into v_sections
  from public.brand_report_sections brs
  where brs.brand_id = any(v_access.brand_ids);

  -- Brand Report Links (auto-render link sections) — same per-brand jsonb
  -- shape as section templates. RLS-gated to authed users on the table, so
  -- the anon portal can only get them through this SECURITY DEFINER RPC.
  select coalesce(jsonb_agg(
    jsonb_build_object('brand_id', brr.brand_id, 'sections', coalesce(brr.sections, '[]'::jsonb))
  ), '[]'::jsonb)
    into v_resources
  from public.brand_report_resources brr
  where brr.brand_id = any(v_access.brand_ids);

  -- Section values for the permitted reports. MUST carry the same gate as the
  -- report list above, or a withheld report's section content would still be
  -- handed to the browser even though its parent row was filtered out.
  select coalesce(jsonb_agg(row_to_json(v) order by v.updated_at desc), '[]'::jsonb)
    into v_values
  from (
    select rsv.report_id, rsv.section_id, rsv.section_name, rsv.value, rsv.updated_at
    from public.report_section_values rsv
    join public.reports r on r.id = rsv.report_id
    where r.brand_id = any(v_access.brand_ids)
      and r.status = 'approved'
      and r.shared_with_client = true
      and r.type = any(v_access.share_types)
  ) v;

  -- View counter (best-effort)
  begin
    update public.client_access set view_count = view_count + 1 where token = p_token;
  exception when others then null; end;

  return jsonb_build_object(
    'access', jsonb_build_object(
      'token',        v_access.token,
      'label',        v_access.label,
      'client_name',  v_access.client_name,
      'brand_ids',    v_access.brand_ids,
      'share_types',  v_access.share_types,
      'expires_at',   v_access.expires_at,
      'created_at',   v_access.created_at
    ),
    'brands',           v_brands,
    'reports',          v_reports,
    'gmv_max',          v_gmv,
    'sections',         v_sections,
    'report_resources', v_resources,
    'section_values',   v_values
  );
end;
$$;
