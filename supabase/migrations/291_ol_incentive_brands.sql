-- ============================================================
-- 291 — OL incentive brands: let each OL curate which brands count toward their
-- incentive, and roll TL brand-target completions up into the OL's %.
--
-- Both OLs see/manage every brand (unchanged). For INCENTIVES, brands are split
-- per-OL: Arslan = Kelsey's brands, Fahad = the rest. Boss rule: an OL earns the
-- incentive when >=70% of THEIR brands hit their GMV target. A brand "hit" =
-- its owning TL marked the matching per-brand GMV incentive item complete.
--
-- This migration:
--   1. ol_incentive_brands(ol_id, brand_id)  — the OL's curated set (Settings).
--   2. Seeds Arslan <- Kelsey brands, Fahad <- non-Kelsey active brands.
--   3. Flags each OL's "Brands hit GMV targets" incentive item source:'ol_brands'
--      so the read-time overlay (incentivesApi) fills its achievedValue with the %.
--   4. RPCs: bulk pct (for the overlay) + per-brand status (for the OL panel).
--      Match TL item <-> brand by normalised name (spaces/punct stripped).
-- ============================================================

create table if not exists public.ol_incentive_brands (
  ol_id     uuid not null references public.profiles(id) on delete cascade,
  brand_id  uuid not null references public.brands(id)   on delete cascade,
  added_at  timestamptz not null default now(),
  primary key (ol_id, brand_id)
);
create index if not exists ol_incentive_brands_ol_idx on public.ol_incentive_brands(ol_id);

alter table public.ol_incentive_brands enable row level security;
drop policy if exists oib_select on public.ol_incentive_brands;
create policy oib_select on public.ol_incentive_brands for select
  using (ol_id = auth.uid() or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active));
drop policy if exists oib_write on public.ol_incentive_brands;
create policy oib_write on public.ol_incentive_brands for all
  using (ol_id = auth.uid() or public.is_boss(auth.uid()))
  with check (ol_id = auth.uid() or public.is_boss(auth.uid()));

do $$ begin
  alter publication supabase_realtime add table public.ol_incentive_brands;
exception when duplicate_object then null; end $$;

-- 2. Seed (data-driven, name-matched so it survives id changes) --------------
insert into public.ol_incentive_brands (ol_id, brand_id)
  select ol.id, b.id
    from public.profiles ol
    cross join public.brands b
   where ol.role = 'ol' and ol.is_active and ol.display_name ilike '%arslan%'
     and b.status = 'active' and lower(trim(coalesce(b.client_name,''))) = 'kelsey'
on conflict do nothing;

insert into public.ol_incentive_brands (ol_id, brand_id)
  select ol.id, b.id
    from public.profiles ol
    cross join public.brands b
   where ol.role = 'ol' and ol.is_active and ol.display_name ilike '%fahad%'
     and b.status = 'active' and lower(trim(coalesce(b.client_name,''))) <> 'kelsey'
on conflict do nothing;

-- 3. Flag each OL's "Brands hit GMV targets" meta-item with source:'ol_brands'.
update public.incentives i
   set incentives = (
     select jsonb_agg(
       case when lower(coalesce(elem->>'text','')) like '%brands hit%gmv%'
            then elem || '{"source":"ol_brands","suffix":"%"}'::jsonb
            else elem end)
       from jsonb_array_elements(i.incentives) elem)
  from public.profiles p
 where p.id = i.user_id and p.role = 'ol'
   and i.incentives is not null and jsonb_typeof(i.incentives) = 'array'
   and exists (select 1 from jsonb_array_elements(i.incentives) e
                where lower(coalesce(e->>'text','')) like '%brands hit%gmv%');

-- 4a. Bulk % (overlay + payout snapshot). For each OL: hits / total of their
--     curated ACTIVE brands, where a brand "hit" = owning TL has a COMPLETED
--     incentive item whose normalised text contains the normalised brand name.
create or replace function public.ol_brand_incentive_pct(p_month text, p_ol_ids uuid[])
returns table (ol_id uuid, hits int, total int, pct numeric)
language sql security definer set search_path = public stable
as $$
  with sel as (
    select oib.ol_id, b.brand_name, b.owner_id
      from public.ol_incentive_brands oib
      join public.brands b on b.id = oib.brand_id and b.status = 'active'
     where oib.ol_id = any(p_ol_ids)
  ),
  hit as (
    select s.ol_id,
      exists (
        select 1
          from public.incentives inc
          cross join lateral jsonb_array_elements(coalesce(inc.incentives,'[]'::jsonb)) it
         where inc.user_id = s.owner_id and inc.month = p_month
           and (it->>'completed')::boolean is true
           and regexp_replace(lower(coalesce(it->>'text','')), '[^a-z0-9]', '', 'g')
               like '%' || regexp_replace(lower(s.brand_name), '[^a-z0-9]', '', 'g') || '%'
      ) as is_hit
      from sel s
  )
  select h.ol_id,
         count(*) filter (where h.is_hit)::int as hits,
         count(*)::int as total,
         case when count(*) > 0
              then round(count(*) filter (where h.is_hit)::numeric / count(*) * 100)
              else 0 end as pct
    from hit h
   group by h.ol_id;
$$;
revoke execute on function public.ol_brand_incentive_pct(text, uuid[]) from public, anon;
grant  execute on function public.ol_brand_incentive_pct(text, uuid[]) to authenticated;

-- 4b. Per-brand status for the OL panel: which TL item matched + hit/not.
create or replace function public.ol_brand_incentive_status(p_ol uuid, p_month text)
returns table (brand_id uuid, brand_name text, client_name text, owner_name text, matched_text text, is_hit boolean)
language plpgsql security definer set search_path = public stable
as $$
begin
  if not (auth.uid() = p_ol or public.is_boss(auth.uid())
      or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active))
  then return; end if;

  return query
    select b.id, b.brand_name, b.client_name, ow.display_name, m.text, coalesce(m.completed, false)
      from public.ol_incentive_brands oib
      join public.brands b on b.id = oib.brand_id and b.status = 'active'
      left join public.profiles ow on ow.id = b.owner_id
      left join lateral (
        select it->>'text' as text, (it->>'completed')::boolean as completed
          from public.incentives inc
          cross join lateral jsonb_array_elements(coalesce(inc.incentives,'[]'::jsonb)) it
         where inc.user_id = b.owner_id and inc.month = p_month
           and regexp_replace(lower(coalesce(it->>'text','')), '[^a-z0-9]', '', 'g')
               like '%' || regexp_replace(lower(b.brand_name), '[^a-z0-9]', '', 'g') || '%'
         order by (it->>'completed')::boolean desc nulls last
         limit 1
      ) m on true
     where oib.ol_id = p_ol
     order by b.brand_name;
end;
$$;
revoke execute on function public.ol_brand_incentive_status(uuid, text) from public, anon;
grant  execute on function public.ol_brand_incentive_status(uuid, text) to authenticated;
