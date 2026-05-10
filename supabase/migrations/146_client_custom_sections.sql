-- ============================================================
-- 146 — Client custom sections (per-brand, per-report values)
--
-- Mirrors v1's `brandReportSections` Firestore feature: clients can
-- add persistent sections for a brand from their portal, and fill
-- in per-report values. Internal app users (Boss/OL/TL/APC) see the
-- same sections + values when viewing the same report inside the app.
--
-- Two layers:
--   1. Templates per brand:    brand_report_sections (brand_id, section_id, name, …)
--   2. Values per report:      report_section_values (report_id, section_id, name, value, …)
--
-- All client-side writes go through SECURITY DEFINER RPCs that take
-- the access token as the auth proof. Token must be active, not
-- revoked, not expired, and the brand_id (or report's brand_id)
-- must be in the token's brand_ids list.
--
-- Internal app users read both tables directly via permissive RLS
-- (anyone authenticated can SELECT — same model as reports).
-- App-side writes are blocked at the RLS layer to keep the
-- permission model simple — clients manage; team views.
-- ============================================================

-- ── Templates: one row per (brand, section) ─────────────────────
create table if not exists public.brand_report_sections (
  brand_id     uuid    not null references public.brands(id) on delete cascade,
  section_id   text    not null,
  name         text    not null,
  added_by     text    not null default 'client',  -- 'client' | 'team'
  added_at     timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (brand_id, section_id)
);

create index if not exists brand_report_sections_brand_idx
  on public.brand_report_sections(brand_id);

-- ── Values: one row per (report, section) ───────────────────────
create table if not exists public.report_section_values (
  report_id    uuid    not null references public.reports(id) on delete cascade,
  section_id   text    not null,
  section_name text    not null,                  -- denormalized for resilience to rename
  value        text    not null default '',
  updated_at   timestamptz not null default now(),
  primary key (report_id, section_id)
);

create index if not exists report_section_values_report_idx
  on public.report_section_values(report_id);

-- ── RLS — read for any authenticated user; writes blocked
--    (client writes go through SECURITY DEFINER RPCs below) ─────
alter table public.brand_report_sections   enable row level security;
alter table public.report_section_values   enable row level security;

drop policy if exists "brs_select" on public.brand_report_sections;
create policy "brs_select"
  on public.brand_report_sections for select
  using (auth.uid() is not null);

drop policy if exists "rsv_select" on public.report_section_values;
create policy "rsv_select"
  on public.report_section_values for select
  using (auth.uid() is not null);

-- (No INSERT/UPDATE/DELETE policies — direct writes blocked. Use the
--  client_section_* RPCs below or admin-side RPCs we may add later.)

-- ============================================================
-- Token validation helper — used by every client-side mutator.
-- Returns the access row only if active+not-revoked+not-expired.
-- ============================================================
create or replace function public._client_access_check(p_token text)
returns public.client_access
language plpgsql
security definer
set search_path = public
as $$
declare
  v_access public.client_access%rowtype;
begin
  select * into v_access from public.client_access where token = p_token;
  if not found                          then raise exception 'access_not_found' using errcode = 'P0002'; end if;
  if v_access.active = false            then raise exception 'access_disabled'  using errcode = 'P0003'; end if;
  if v_access.revoked_at is not null    then raise exception 'access_revoked'   using errcode = 'P0003'; end if;
  if v_access.expires_at is not null and v_access.expires_at < now()
                                         then raise exception 'access_expired'  using errcode = 'P0004'; end if;
  return v_access;
end;
$$;

-- ============================================================
-- 1. ADD a new section template under a brand.
--    Errors:
--      access_*           → token problems
--      brand_not_in_token → brand_id not in token's brand_ids
--      section_name_empty → trimmed name is empty
--      section_duplicate  → another section with same name (case-insensitive)
-- ============================================================
create or replace function public.client_section_add(
  p_token      text,
  p_brand_id   uuid,
  p_name       text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_access  public.client_access%rowtype;
  v_trimmed text := trim(coalesce(p_name, ''));
  v_id      text;
begin
  v_access := public._client_access_check(p_token);
  if not (p_brand_id = any(v_access.brand_ids)) then
    raise exception 'brand_not_in_token' using errcode = 'P0005';
  end if;
  if v_trimmed = '' then
    raise exception 'section_name_empty' using errcode = 'P0006';
  end if;
  if exists (
    select 1 from public.brand_report_sections
     where brand_id = p_brand_id and lower(name) = lower(v_trimmed)
  ) then
    raise exception 'section_duplicate' using errcode = 'P0007';
  end if;

  v_id := 'cs_' || replace(extract(epoch from now())::text, '.', '') || '_' || substr(md5(random()::text), 1, 5);

  insert into public.brand_report_sections (brand_id, section_id, name, added_by)
    values (p_brand_id, v_id, v_trimmed, 'client');

  return jsonb_build_object(
    'brand_id',   p_brand_id,
    'section_id', v_id,
    'name',       v_trimmed,
    'added_by',   'client',
    'added_at',   now()
  );
end;
$$;

-- ============================================================
-- 2. RENAME a section. Token gates the change to that brand only.
-- ============================================================
create or replace function public.client_section_rename(
  p_token      text,
  p_brand_id   uuid,
  p_section_id text,
  p_new_name   text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_access  public.client_access%rowtype;
  v_trimmed text := trim(coalesce(p_new_name, ''));
begin
  v_access := public._client_access_check(p_token);
  if not (p_brand_id = any(v_access.brand_ids)) then
    raise exception 'brand_not_in_token' using errcode = 'P0005';
  end if;
  if v_trimmed = '' then
    raise exception 'section_name_empty' using errcode = 'P0006';
  end if;
  if exists (
    select 1 from public.brand_report_sections
     where brand_id = p_brand_id
       and section_id <> p_section_id
       and lower(name) = lower(v_trimmed)
  ) then
    raise exception 'section_duplicate' using errcode = 'P0007';
  end if;

  update public.brand_report_sections
     set name = v_trimmed,
         updated_at = now()
   where brand_id = p_brand_id
     and section_id = p_section_id;
  -- Also update the denormalized name on every value row so future
  -- reads stay in sync without joining.
  update public.report_section_values rsv
     set section_name = v_trimmed,
         updated_at = now()
   from public.reports r
   where rsv.report_id = r.id
     and r.brand_id = p_brand_id
     and rsv.section_id = p_section_id;
end;
$$;

-- ============================================================
-- 3. REMOVE a section template. Past report values are preserved
--    in v1 ("section will no longer appear here, past values stay").
--    Mirror that: we delete the template, leave the values rows.
-- ============================================================
create or replace function public.client_section_remove(
  p_token      text,
  p_brand_id   uuid,
  p_section_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_access public.client_access%rowtype;
begin
  v_access := public._client_access_check(p_token);
  if not (p_brand_id = any(v_access.brand_ids)) then
    raise exception 'brand_not_in_token' using errcode = 'P0005';
  end if;

  delete from public.brand_report_sections
   where brand_id = p_brand_id
     and section_id = p_section_id;
end;
$$;

-- ============================================================
-- 4. SET (or clear) a section's value on one specific report.
--    Verifies the report belongs to a brand in the token.
-- ============================================================
create or replace function public.client_section_set_value(
  p_token        text,
  p_report_id    uuid,
  p_section_id   text,
  p_section_name text,
  p_value        text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_access     public.client_access%rowtype;
  v_brand_id   uuid;
begin
  v_access := public._client_access_check(p_token);

  select brand_id into v_brand_id from public.reports where id = p_report_id;
  if not found                          then raise exception 'report_not_found' using errcode = 'P0002'; end if;
  if not (v_brand_id = any(v_access.brand_ids)) then
    raise exception 'brand_not_in_token' using errcode = 'P0005';
  end if;

  insert into public.report_section_values (report_id, section_id, section_name, value, updated_at)
    values (p_report_id, p_section_id, coalesce(p_section_name, ''), coalesce(p_value, ''), now())
  on conflict (report_id, section_id) do update
    set value        = excluded.value,
        section_name = excluded.section_name,
        updated_at   = now();
end;
$$;

-- Grants — anon (no auth) and authenticated can call all 4 RPCs.
-- Token check inside each RPC is the actual access gate.
grant execute on function public._client_access_check(text)                              to anon, authenticated;
grant execute on function public.client_section_add(text, uuid, text)                    to anon, authenticated;
grant execute on function public.client_section_rename(text, uuid, text, text)           to anon, authenticated;
grant execute on function public.client_section_remove(text, uuid, text)                 to anon, authenticated;
grant execute on function public.client_section_set_value(text, uuid, text, text, text)  to anon, authenticated;

-- ============================================================
-- Update get_client_access to also return:
--   * sections:       brand_report_sections rows for permitted brands
--   * section_values: report_section_values rows for permitted reports
-- so the client portal renders in one round-trip.
-- ============================================================
create or replace function public.get_client_access(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_access   public.client_access%rowtype;
  v_brands   jsonb;
  v_reports  jsonb;
  v_gmv      jsonb;
  v_sections jsonb;
  v_values   jsonb;
begin
  select * into v_access from public.client_access where token = p_token;
  if not found                          then raise exception 'access_not_found' using errcode = 'P0002'; end if;
  if v_access.active = false            then raise exception 'access_disabled'  using errcode = 'P0003'; end if;
  if v_access.revoked_at is not null    then raise exception 'access_revoked'   using errcode = 'P0003'; end if;
  if v_access.expires_at is not null and v_access.expires_at < now()
                                         then raise exception 'access_expired'  using errcode = 'P0004'; end if;

  -- Brands list
  select coalesce(jsonb_agg(
    jsonb_build_object('id', b.id, 'brand_name', b.brand_name, 'logo_url', b.logo_url)
    order by b.brand_name
  ), '[]'::jsonb)
    into v_brands
  from public.brands b
  where b.id = any(v_access.brand_ids);

  -- Reports list — only approved reports for permitted brands and types
  if v_access.share_types && array['weekly','biweekly','monthly'] then
    select coalesce(jsonb_agg(row_to_json(t) order by t.period_start desc), '[]'::jsonb)
      into v_reports
    from (
      select r.id, r.brand_id, r.type,
             r.period_start, r.period_end, r.period_label, r.period_year, r.period_month,
             r.status, r.data, r.updated_at, r.created_at,
             p.display_name as author_name,
             b.brand_name, b.logo_url
      from public.reports r
      left join public.profiles p on p.id = r.author_id
      left join public.brands   b on b.id = r.brand_id
      where r.brand_id = any(v_access.brand_ids)
        and r.status = 'approved'
        and r.type = any(v_access.share_types)
    ) t;
  else
    v_reports := '[]'::jsonb;
  end if;

  -- GMV Max list — full rows for permitted brands
  if 'gmvMax' = any(v_access.share_types) then
    select coalesce(jsonb_agg(row_to_json(g) order by g.period_start desc), '[]'::jsonb)
      into v_gmv
    from (
      select gm.*, b.brand_name as brand_name_lookup, b.logo_url
      from public.gmv_max_reports gm
      left join public.brands b on b.id = gm.brand_id
      where gm.brand_id = any(v_access.brand_ids)
    ) g;
  else
    v_gmv := '[]'::jsonb;
  end if;

  -- Section templates for permitted brands
  select coalesce(jsonb_agg(row_to_json(s) order by s.added_at), '[]'::jsonb)
    into v_sections
  from (
    select brand_id, section_id, name, added_by, added_at
    from public.brand_report_sections
    where brand_id = any(v_access.brand_ids)
  ) s;

  -- Section values for the reports we returned above (subquery against
  -- the same approved-and-permitted set so we don't leak values from
  -- non-permitted brands).
  select coalesce(jsonb_agg(row_to_json(v) order by v.updated_at desc), '[]'::jsonb)
    into v_values
  from (
    select rsv.report_id, rsv.section_id, rsv.section_name, rsv.value, rsv.updated_at
    from public.report_section_values rsv
    join public.reports r on r.id = rsv.report_id
    where r.brand_id = any(v_access.brand_ids)
      and r.status = 'approved'
      and r.type = any(v_access.share_types)
  ) v;

  -- Bump view counter (best-effort)
  begin
    update public.client_access
       set view_count = view_count + 1
     where token = p_token;
  exception when others then
    null;
  end;

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
    'brands',         v_brands,
    'reports',        v_reports,
    'gmv_max',        v_gmv,
    'sections',       v_sections,
    'section_values', v_values
  );
end;
$$;
