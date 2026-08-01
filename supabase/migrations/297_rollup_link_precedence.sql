-- ============================================================
-- 297 — Roll-up review fixes (money correctness):
--
-- (1) FUZZY OVER-REACH (mig 296 gap): a brand's hit was `exists(completed item
--     that links by brandId OR (is unlinked AND text contains brand name))`. In a
--     LINKED month (August+) an unlinked "Other" item whose text merely contains
--     the brand name (e.g. "Onboard Nabaa creators") could mark the brand hit even
--     though its real linked GMV target is incomplete → inflates the OL %.
--     FIX: precedence. If the owner has ANY explicit link for the brand, the hit is
--     decided ONLY by linked items; the fuzzy text path is used solely when NO link
--     exists (i.e. July / legacy plans). July stays byte-identical (no links → fuzzy).
--
-- (2) SOURCE GUARD: never let an attendance/ol_brands item decide a brand GMV hit,
--     even if one ever carried a brandId.
--
-- (3) STATUS ORDERING: the panel picked link-first then completed, so an INCOMPLETE
--     linked item hid a (now-suppressed) completed fuzzy one. Align the panel with
--     pct — order completed-first, and match with the same link-precedence — so the
--     Boss/OL verification backstop shows the same hit the payout is based on.
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
        (case when coalesce(x.has_link, false)
              then coalesce(x.link_hit, false)      -- linked brand → link decides
              else coalesce(x.fuzzy_hit, false)     -- no link (July/legacy) → fuzzy
         end) as is_hit
        from sel s
        cross join lateral (
          select
            bool_or((it->>'brandId') = s.brand_id::text) as has_link,
            bool_or((it->>'brandId') = s.brand_id::text and (it->>'completed')::boolean is true) as link_hit,
            bool_or((it->>'brandId') is null and (it->>'completed')::boolean is true
                    and length(s.norm_brand) >= 3
                    and regexp_replace(lower(coalesce(it->>'text','')), '[^a-z0-9]', '', 'g')
                        like '%' || s.norm_brand || '%') as fuzzy_hit
          from public.incentives inc
          cross join lateral jsonb_array_elements(
            coalesce(inc.incentives,'[]'::jsonb) || coalesce(inc.bonuses,'[]'::jsonb)) it
          where inc.user_id = s.owner_id and inc.month = p_month
            and coalesce(it->>'source','') not in ('attendance','ol_brands')
        ) x
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
    select b.id, b.brand_name, b.client_name, ow.display_name,
           m.text,
           (case when coalesce(x.has_link,false) then coalesce(x.link_hit,false) else coalesce(x.fuzzy_hit,false) end) as is_hit,
           (case when coalesce(x.has_link,false) then 'link' else 'text' end) as matched_by
      from public.ol_incentive_brands oib
      join public.brands b on b.id = oib.brand_id and b.status = 'active'
      left join public.profiles ow on ow.id = b.owner_id
      -- per-brand hit summary (identical logic to ol_brand_incentive_pct)
      cross join lateral (
        select
          bool_or((it->>'brandId') = b.id::text) as has_link,
          bool_or((it->>'brandId') = b.id::text and (it->>'completed')::boolean is true) as link_hit,
          bool_or((it->>'brandId') is null and (it->>'completed')::boolean is true
                  and length(regexp_replace(lower(b.brand_name),'[^a-z0-9]','','g')) >= 3
                  and regexp_replace(lower(coalesce(it->>'text','')),'[^a-z0-9]','','g')
                      like '%' || regexp_replace(lower(b.brand_name),'[^a-z0-9]','','g') || '%') as fuzzy_hit
        from public.incentives inc
        cross join lateral jsonb_array_elements(
          coalesce(inc.incentives,'[]'::jsonb) || coalesce(inc.bonuses,'[]'::jsonb)) it
        where inc.user_id = b.owner_id and inc.month = p_month
          and coalesce(it->>'source','') not in ('attendance','ol_brands')
      ) x
      -- the item to SHOW: same link-precedence, completed-first so a real hit surfaces
      left join lateral (
        select it->>'text' as text
          from public.incentives inc
          cross join lateral jsonb_array_elements(
            coalesce(inc.incentives,'[]'::jsonb) || coalesce(inc.bonuses,'[]'::jsonb)) it
         where inc.user_id = b.owner_id and inc.month = p_month
           and coalesce(it->>'source','') not in ('attendance','ol_brands')
           and (case when coalesce(x.has_link,false)
                     then (it->>'brandId') = b.id::text
                     else ((it->>'brandId') is null
                           and length(regexp_replace(lower(b.brand_name),'[^a-z0-9]','','g')) >= 3
                           and regexp_replace(lower(coalesce(it->>'text','')),'[^a-z0-9]','','g')
                               like '%' || regexp_replace(lower(b.brand_name),'[^a-z0-9]','','g') || '%')
                end)
         order by (it->>'completed')::boolean desc nulls last
         limit 1
      ) m on true
     where oib.ol_id = p_ol
     order by b.brand_name;
end;
$$;
revoke execute on function public.ol_brand_incentive_status(uuid, text) from public, anon;
grant  execute on function public.ol_brand_incentive_status(uuid, text) to authenticated;
