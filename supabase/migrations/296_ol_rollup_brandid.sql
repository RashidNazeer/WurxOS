-- ============================================================
-- 296 — OL roll-up matches by hard brand link (item.brandId), falling back to the
-- old normalised-text match ONLY when an item has no link.
--
-- Why the fallback (not a hard cutover): July 2026 plans are frozen for payroll and
-- must not be touched, so their items carry NO brandId. An item with no brandId keeps
-- today's fuzzy behaviour; an item WITH a brandId (August onward) matches exactly by
-- id. Because the gate is per-item (brandId present or not), July stays byte-identical
-- and only linked months get the precise match — no month logic, no payroll risk.
--
-- A brand "hits" for its owning TL when that TL has a COMPLETED item that either
--   (a) has brandId = the brand's id (new model), or
--   (b) has NO brandId and its normalised text contains the normalised brand name.
-- Additive + backward-compatible: revert = redeploy old frontend; these RPCs still
-- read correctly whether or not any item carries a brandId.
-- ============================================================

create or replace function public.ol_brand_incentive_pct(p_month text, p_ol_ids uuid[])
returns table (ol_id uuid, hits int, total int, pct numeric)
language plpgsql security definer set search_path = public stable
as $$
begin
  if not (
    public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active)
  ) then return; end if;

  return query
    with sel as (
      select oib.ol_id, b.id as brand_id, b.owner_id,
             regexp_replace(lower(b.brand_name), '[^a-z0-9]', '', 'g') as norm_brand
        from public.ol_incentive_brands oib
        join public.brands b on b.id = oib.brand_id and b.status = 'active'
       where oib.ol_id = any(p_ol_ids)
    ),
    hit as (
      select s.ol_id,
        exists (
          select 1
            from public.incentives inc
            cross join lateral jsonb_array_elements(
              coalesce(inc.incentives,'[]'::jsonb) || coalesce(inc.bonuses,'[]'::jsonb)) it
           where inc.user_id = s.owner_id and inc.month = p_month
             and (it->>'completed')::boolean is true
             and (
               -- (a) exact brand link
               (it->>'brandId') = s.brand_id::text
               -- (b) fallback: unlinked item, normalised-text contains the brand name
               or ( (it->>'brandId') is null
                    and length(s.norm_brand) >= 3
                    and regexp_replace(lower(coalesce(it->>'text','')), '[^a-z0-9]', '', 'g')
                        like '%' || s.norm_brand || '%' )
             )
        ) as is_hit
        from sel s
    )
    select h.ol_id,
           count(*) filter (where h.is_hit)::int,
           count(*)::int,
           case when count(*) > 0
                then round(count(*) filter (where h.is_hit)::numeric / count(*) * 100)
                else 0 end
      from hit h
     group by h.ol_id;
end;
$$;
revoke execute on function public.ol_brand_incentive_pct(text, uuid[]) from public, anon;
grant  execute on function public.ol_brand_incentive_pct(text, uuid[]) to authenticated;

-- Per-brand status for the OL panel — same brandId-or-text match, and it now also
-- reports which mechanism matched (so the panel can show a link vs a loose text guess).
-- Return signature gains a column, so drop the old one first (create-or-replace can't
-- change a function's return type).
drop function if exists public.ol_brand_incentive_status(uuid, text);
create or replace function public.ol_brand_incentive_status(p_ol uuid, p_month text)
returns table (brand_id uuid, brand_name text, client_name text, owner_name text, matched_text text, is_hit boolean, matched_by text)
language plpgsql security definer set search_path = public stable
as $$
begin
  if not (
    public.is_boss(auth.uid())
    or (p_ol = auth.uid()
        and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active))
  ) then return; end if;

  return query
    select b.id, b.brand_name, b.client_name, ow.display_name, m.text, coalesce(m.completed, false), m.matched_by
      from public.ol_incentive_brands oib
      join public.brands b on b.id = oib.brand_id and b.status = 'active'
      left join public.profiles ow on ow.id = b.owner_id
      left join lateral (
        select it->>'text' as text,
               (it->>'completed')::boolean as completed,
               case when (it->>'brandId') = b.id::text then 'link' else 'text' end as matched_by
          from public.incentives inc
          cross join lateral jsonb_array_elements(
            coalesce(inc.incentives,'[]'::jsonb) || coalesce(inc.bonuses,'[]'::jsonb)) it
         where inc.user_id = b.owner_id and inc.month = p_month
           and (
             (it->>'brandId') = b.id::text
             or ( (it->>'brandId') is null
                  and length(regexp_replace(lower(b.brand_name), '[^a-z0-9]', '', 'g')) >= 3
                  and regexp_replace(lower(coalesce(it->>'text','')), '[^a-z0-9]', '', 'g')
                      like '%' || regexp_replace(lower(b.brand_name), '[^a-z0-9]', '', 'g') || '%' )
           )
         -- prefer an exact link, then a completed one
         order by (case when (it->>'brandId') = b.id::text then 0 else 1 end),
                  (it->>'completed')::boolean desc nulls last
         limit 1
      ) m on true
     where oib.ol_id = p_ol
     order by b.brand_name;
end;
$$;
revoke execute on function public.ol_brand_incentive_status(uuid, text) from public, anon;
grant  execute on function public.ol_brand_incentive_status(uuid, text) to authenticated;
