-- ============================================================
-- 109 — Client Access Links
--
-- Aggregate share link that bundles multiple data surfaces for a
-- set of brands. Replaces v1's `clientAccess` Firestore collection.
--
-- One row per link. The link points at any subset of:
--   * weekly reports
--   * biweekly reports
--   * paid collab data
--   * GMV Max reporting
--
-- (v1 also has a "monthly" toggle for monthly reports, but v2 does
-- not yet have a monthly_reports table — that toggle is omitted
-- here. The schema accepts 'monthly' so it can be added later.)
--
-- Surfaces are exposed publicly via the get_client_access(token)
-- RPC, which is SECURITY DEFINER and enforces every check inside.
-- ============================================================

create table if not exists public.client_access (
  id              uuid primary key default gen_random_uuid(),
  token           text not null unique,
  label           text not null default '',
  client_name     text default '',

  brand_ids       uuid[] not null default '{}',
  share_types     text[] not null default '{}'
                    check (
                      share_types <@ array['weekly','biweekly','monthly','paidCollab','gmvMax']
                    ),

  active          boolean not null default true,
  expires_at      timestamptz,
  revoked_at      timestamptz,
  view_count      int not null default 0,

  created_at      timestamptz not null default now(),
  created_by      uuid references public.profiles(id) on delete set null,
  created_by_name text
);

create index if not exists client_access_token_idx on public.client_access(token);
create index if not exists client_access_creator_idx on public.client_access(created_by);
create index if not exists client_access_brands_idx on public.client_access using gin(brand_ids);

-- ============================================================
-- RLS — only Boss / OL / Developer can manage links
-- ============================================================
alter table public.client_access enable row level security;

drop policy if exists "ca_select" on public.client_access;
create policy "ca_select"
  on public.client_access for select
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.is_active = true
        and p.role in ('boss','ol','developer')
    )
  );

drop policy if exists "ca_insert" on public.client_access;
create policy "ca_insert"
  on public.client_access for insert
  with check (
    auth.uid() = created_by
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.is_active = true
        and p.role in ('boss','ol','developer')
    )
  );

drop policy if exists "ca_update" on public.client_access;
create policy "ca_update"
  on public.client_access for update
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.is_active = true
        and p.role in ('boss','ol','developer')
    )
  )
  with check (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.is_active = true
        and p.role in ('boss','ol','developer')
    )
  );

drop policy if exists "ca_delete" on public.client_access;
create policy "ca_delete"
  on public.client_access for delete
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.is_active = true
        and p.role in ('boss','ol','developer')
    )
  );

-- ============================================================
-- Public RPC — resolve a client access token.
--
-- Returns:
--   {
--     access:  { token, label, client_name, share_types, expires_at, ... },
--     brands:  [ { id, brand_name, logo_url } ],
--     reports: [ { id, brand_id, type, period_start, period_end,
--                  period_label, status, data, updated_at, author_name } ]
--              -- only approved reports for permitted brands and
--              -- only the report types in share_types
--     gmv_max: [ full gmv_max_reports rows for permitted brands ]
--              -- empty if 'gmvMax' not in share_types
--   }
--
-- Paid collab data lives in an external Google Sheets API and is
-- fetched client-side using the returned brand list.
-- ============================================================
create or replace function public.get_client_access(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_access  public.client_access%rowtype;
  v_brands  jsonb;
  v_reports jsonb;
  v_gmv     jsonb;
begin
  select * into v_access from public.client_access where token = p_token;
  if not found                          then raise exception 'access_not_found' using errcode = 'P0002'; end if;
  if v_access.active = false            then raise exception 'access_disabled'  using errcode = 'P0003'; end if;
  if v_access.revoked_at is not null    then raise exception 'access_revoked'   using errcode = 'P0003'; end if;
  if v_access.expires_at is not null and v_access.expires_at < now()
                                         then raise exception 'access_expired'   using errcode = 'P0004'; end if;

  -- Brands list
  select coalesce(jsonb_agg(
    jsonb_build_object('id', b.id, 'brand_name', b.brand_name, 'logo_url', b.logo_url)
    order by b.brand_name
  ), '[]'::jsonb)
    into v_brands
  from public.brands b
  where b.id = any(v_access.brand_ids);

  -- Reports list — only approved reports for permitted brands and types
  if v_access.share_types && array['weekly','biweekly'] then
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
    'brands',  v_brands,
    'reports', v_reports,
    'gmv_max', v_gmv
  );
end;
$$;

grant execute on function public.get_client_access(text) to anon, authenticated;
