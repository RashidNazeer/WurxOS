-- ============================================================
-- 280 — Per-brand currency = single source of truth for money symbols.
--
-- Problem: currency was only ever a per-report snapshot (reports.data->>'currency',
-- default 'USD'). So when a brand switched to GBP, only NEW reports showed £ while
-- every historical report kept showing $ — the money symbol was inconsistent across
-- a brand's reports, the brand pages, and the client portal.
--
-- Fix: give each brand ONE currency. Display resolves the symbol from the brand
-- (see _normReport / the portal adapter), overriding the legacy per-report snapshot,
-- so changing a brand's currency reflects across ALL its reports — past and future —
-- at once, with no re-stamping of historical rows.
--
-- Amounts are never converted; only the symbol shown changes (values were always
-- entered as raw numbers).
-- ============================================================

alter table public.brands
  add column if not exists currency text not null default 'USD';

-- Backfill each brand from its most-recent report that actually set a currency, so
-- brands already reporting in £/€/etc keep it instead of snapping back to USD. Brands
-- with no non-USD history stay at the 'USD' default.
update public.brands b
set currency = sub.cur
from (
  select distinct on (r.brand_id)
         r.brand_id,
         nullif(r.data->>'currency', '') as cur
  from public.reports r
  where nullif(r.data->>'currency', '') is not null
  order by r.brand_id, r.period_start desc nulls last, r.created_at desc
) sub
where sub.brand_id = b.id
  and sub.cur is not null
  and sub.cur <> b.currency;

-- ------------------------------------------------------------
-- Expose the brand currency to the anonymous client portal.
-- Verbatim copy of migration 196's get_client_access, with two additive changes:
--   * each brand object now carries 'currency'
--   * each report row now carries brand_currency (the adapter resolves the
--     display currency from it, overriding the legacy per-report data.currency)
-- ------------------------------------------------------------
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

  -- Reports — approved + permitted brands + permitted types
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
    'brands',           v_brands,
    'reports',          v_reports,
    'gmv_max',          v_gmv,
    'sections',         v_sections,
    'report_resources', v_resources,
    'section_values',   v_values
  );
end;
$$;
