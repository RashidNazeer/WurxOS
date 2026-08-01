-- ============================================================
-- 292 — Gate ol_brand_incentive_pct to OL/Boss/Developer callers.
--
-- mig 291's ol_brand_incentive_pct is SECURITY DEFINER (revoked from public/anon,
-- granted to authenticated) but had no in-body caller check, so any authenticated
-- user could read any OL's brand-hit %. Only OLs/Boss/Developer ever deal with OL
-- incentives; gate to them (the read-time overlay only calls it for OL rows, which
-- only OL-self or Boss view). Body is otherwise identical to mig 291.
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
