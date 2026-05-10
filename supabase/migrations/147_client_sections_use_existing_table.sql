-- ============================================================
-- 147 — Reconcile client-side custom sections with the existing
-- author-side `brand_report_sections` table.
--
-- Background: migration 146 tried to create brand_report_sections
-- as (brand_id, section_id, name, …) one-row-per-section, but
-- migration 104 already created brand_report_sections as
-- (brand_id pk, sections jsonb) — one-row-per-brand with the
-- whole list inside a jsonb array (mirroring v1's Firestore shape).
-- Mig 146's create-if-not-exists silently no-op'd, so the table
-- still has the jsonb shape. The 4 client_section_* RPCs the mig
-- defined assume the wrong shape.
--
-- This migration rewrites all 4 RPCs to operate on the jsonb
-- `sections` array — same approach as the author-side
-- brandReportSectionsApi.js — so client + author writes share one
-- source of truth (same as v1).
--
-- We also drop the bogus brs_select policy mig 146 added that
-- restricted reads to authenticated users (mig 104 already had
-- a permissive auth.role()='authenticated' policy that this
-- migration leaves alone). Public anon reads continue to flow
-- through the get_client_access RPC (which is SECURITY DEFINER
-- and bypasses RLS).
-- ============================================================

-- 1. ADD a section template to the brand's jsonb array.
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
  v_access   public.client_access%rowtype;
  v_trimmed  text := trim(coalesce(p_name, ''));
  v_id       text;
  v_existing jsonb;
  v_new      jsonb;
begin
  v_access := public._client_access_check(p_token);
  if not (p_brand_id = any(v_access.brand_ids)) then
    raise exception 'brand_not_in_token' using errcode = 'P0005';
  end if;
  if v_trimmed = '' then
    raise exception 'section_name_empty' using errcode = 'P0006';
  end if;

  -- Load the current jsonb array (or [] if no row yet).
  select coalesce(sections, '[]'::jsonb) into v_existing
    from public.brand_report_sections where brand_id = p_brand_id;
  if v_existing is null then v_existing := '[]'::jsonb; end if;

  -- Reject duplicates (case-insensitive name match).
  if exists (
    select 1 from jsonb_array_elements(v_existing) e
    where lower(e->>'name') = lower(v_trimmed)
  ) then
    raise exception 'section_duplicate' using errcode = 'P0007';
  end if;

  v_id := 'cs_' || replace(extract(epoch from now())::text, '.', '') || '_' || substr(md5(random()::text), 1, 5);

  v_new := jsonb_build_object(
    'id',       v_id,
    'name',     v_trimmed,
    'addedBy',  'client',
    'addedAt',  extract(epoch from now())::bigint * 1000  -- v1-compat: ms since epoch
  );

  insert into public.brand_report_sections (brand_id, sections)
    values (p_brand_id, v_existing || jsonb_build_array(v_new))
  on conflict (brand_id) do update
    set sections = excluded.sections;

  return v_new;
end;
$$;

-- 2. RENAME a section in the jsonb array (and all denormalized values).
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
  v_access   public.client_access%rowtype;
  v_trimmed  text := trim(coalesce(p_new_name, ''));
  v_existing jsonb;
  v_updated  jsonb;
begin
  v_access := public._client_access_check(p_token);
  if not (p_brand_id = any(v_access.brand_ids)) then
    raise exception 'brand_not_in_token' using errcode = 'P0005';
  end if;
  if v_trimmed = '' then
    raise exception 'section_name_empty' using errcode = 'P0006';
  end if;

  select coalesce(sections, '[]'::jsonb) into v_existing
    from public.brand_report_sections where brand_id = p_brand_id;
  if v_existing is null or v_existing = '[]'::jsonb then return; end if;

  -- Reject duplicates (excluding the section we're renaming).
  if exists (
    select 1 from jsonb_array_elements(v_existing) e
    where lower(e->>'name') = lower(v_trimmed)
      and e->>'id' <> p_section_id
  ) then
    raise exception 'section_duplicate' using errcode = 'P0007';
  end if;

  -- Build a new array with the rename applied.
  select coalesce(jsonb_agg(
    case when e->>'id' = p_section_id then
      jsonb_set(e, '{name}', to_jsonb(v_trimmed))
    else e end
  ), '[]'::jsonb) into v_updated
  from jsonb_array_elements(v_existing) e;

  update public.brand_report_sections
     set sections = v_updated
   where brand_id = p_brand_id;

  -- Sync the denormalized name on every value row for this section.
  update public.report_section_values rsv
     set section_name = v_trimmed,
         updated_at = now()
   from public.reports r
   where rsv.report_id = r.id
     and r.brand_id = p_brand_id
     and rsv.section_id = p_section_id;
end;
$$;

-- 3. REMOVE a section from the jsonb array. Past values rows are
--    preserved (mirrors v1 behavior).
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
  v_access   public.client_access%rowtype;
  v_existing jsonb;
  v_updated  jsonb;
begin
  v_access := public._client_access_check(p_token);
  if not (p_brand_id = any(v_access.brand_ids)) then
    raise exception 'brand_not_in_token' using errcode = 'P0005';
  end if;

  select coalesce(sections, '[]'::jsonb) into v_existing
    from public.brand_report_sections where brand_id = p_brand_id;
  if v_existing is null or v_existing = '[]'::jsonb then return; end if;

  select coalesce(jsonb_agg(e), '[]'::jsonb) into v_updated
  from jsonb_array_elements(v_existing) e
  where e->>'id' <> p_section_id;

  update public.brand_report_sections
     set sections = v_updated
   where brand_id = p_brand_id;
end;
$$;

-- 4. SET (or update) a section's value on a specific report.
--    Same as mig 146 — the report_section_values table is correctly
--    shaped already; mig 146 created it without conflict.
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

grant execute on function public.client_section_add(text, uuid, text)                    to anon, authenticated;
grant execute on function public.client_section_rename(text, uuid, text, text)           to anon, authenticated;
grant execute on function public.client_section_remove(text, uuid, text)                 to anon, authenticated;
grant execute on function public.client_section_set_value(text, uuid, text, text, text)  to anon, authenticated;

-- ============================================================
-- get_client_access — return sections in the v1 jsonb-array shape
-- (one row per brand: { brand_id, sections: [{id, name, ...}] }).
-- The portal client already knows how to walk that shape.
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

  -- Brands
  select coalesce(jsonb_agg(
    jsonb_build_object('id', b.id, 'brand_name', b.brand_name, 'logo_url', b.logo_url)
    order by b.brand_name
  ), '[]'::jsonb)
    into v_brands
  from public.brands b
  where b.id = any(v_access.brand_ids);

  -- Reports — approved + permitted brands + permitted types
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

  -- GMV Max
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

  -- Section templates — one entry per brand carrying its jsonb array.
  select coalesce(jsonb_agg(
    jsonb_build_object('brand_id', brs.brand_id, 'sections', coalesce(brs.sections, '[]'::jsonb))
  ), '[]'::jsonb)
    into v_sections
  from public.brand_report_sections brs
  where brs.brand_id = any(v_access.brand_ids);

  -- Section values for the permitted reports.
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
    'brands',         v_brands,
    'reports',        v_reports,
    'gmv_max',        v_gmv,
    'sections',       v_sections,
    'section_values', v_values
  );
end;
$$;
