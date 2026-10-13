-- ============================================================================
-- Read-only audit of the org and brand structure. Changes nothing.
-- Run in the SQL Editor of whichever project you are checking.
--
-- Query 1  the full picture: every active brand, its owner TL, its APCs, its OL
-- Query 2  the problem list: anything that should never be true
-- Query 3  who is who: the roster, current staff first
-- Query 4  report visibility, evaluated per APC against the real RLS functions
--
-- Query 2 returning no rows is the definition of "the structure is correct".
-- ============================================================================

-- 1. THE FULL PICTURE ---------------------------------------------------------
select
  b.brand_name,
  owner.display_name                              as owner_tl,
  owner.role                                      as owner_role,
  coalesce(string_agg(apc.display_name, ', ' order by apc.display_name), '- none -')
                                                  as assigned_apcs,
  coalesce((select string_agg(ol.display_name, ', ' order by ol.display_name)
              from public.ol_incentive_brands oib
              join public.profiles ol on ol.id = oib.ol_id
             where oib.brand_id = b.id), '- none -')
                                                  as ol_set
from public.brands b
join public.profiles owner            on owner.id = b.owner_id
left join public.brand_assignments ba on ba.brand_id = b.id
left join public.profiles apc         on apc.id = ba.user_id
where b.status = 'active'
group by b.id, b.brand_name, owner.display_name, owner.role
order by owner.display_name, b.brand_name;


-- 2. THE PROBLEM LIST ---------------------------------------------------------
select * from (
  select b.brand_name, 'owner has left the company' as problem, p.display_name as who
    from public.brands b join public.profiles p on p.id = b.owner_id
   where b.status = 'active' and p.deleted_at is not null
  union all
  select b.brand_name, 'owner is not a TL (role: ' || p.role || ')', p.display_name
    from public.brands b join public.profiles p on p.id = b.owner_id
   where b.status = 'active' and p.deleted_at is null and p.role not in ('tl','pctl')
  union all
  select b.brand_name, 'no APC assigned', '-'
    from public.brands b
   where b.status = 'active'
     and not exists (select 1 from public.brand_assignments ba where ba.brand_id = b.id)
  union all
  select b.brand_name, 'assigned to someone who has left', p.display_name
    from public.brand_assignments ba
    join public.brands b   on b.id = ba.brand_id
    join public.profiles p on p.id = ba.user_id
   where b.status = 'active' and p.deleted_at is not null
  union all
  select b.brand_name, 'APC works a brand outside their TL', p.display_name
    from public.brand_assignments ba
    join public.brands b   on b.id = ba.brand_id
    join public.profiles p on p.id = ba.user_id
   where b.status = 'active' and p.deleted_at is null and p.role = 'apc'
     and p.reports_to is distinct from b.owner_id
  union all
  select b.brand_name, 'inactive brand still in an OL set', ol.display_name
    from public.ol_incentive_brands oib
    join public.brands b    on b.id = oib.brand_id
    join public.profiles ol on ol.id = oib.ol_id
   where b.status <> 'active'
  union all
  select '-', 'OL set belongs to someone who has left', ol.display_name
    from public.ol_incentive_brands oib
    join public.profiles ol on ol.id = oib.ol_id
   where ol.deleted_at is not null
  union all
  select '-', 'APC reports to a non-TL', p.display_name
    from public.profiles p join public.profiles m on m.id = p.reports_to
   where p.deleted_at is null and p.role = 'apc' and m.role not in ('tl','pctl')
  union all
  select '-', 'reports to someone who has left', p.display_name
    from public.profiles p join public.profiles m on m.id = p.reports_to
   where p.deleted_at is null and m.deleted_at is not null
) t
order by problem, brand_name;


-- 3. WHO IS WHO ---------------------------------------------------------------
select
  p.display_name, p.role,
  case when p.deleted_at is not null then 'EX-EMPLOYEE since ' || p.deleted_at::date
       when p.is_active is false     then 'inactive'
       else 'current' end                 as status,
  coalesce(m.display_name, '-')           as reports_to
from public.profiles p
left join public.profiles m on m.id = p.reports_to
order by (p.deleted_at is not null),
  case p.role when 'boss' then 1 when 'ol' then 2 when 'tl' then 3
              when 'pctl' then 4 when 'apc' then 5 when 'ipc' then 6 else 7 end,
  p.display_name;


-- 4. CAN EACH APC ACTUALLY SEE THEIR REPORTS? ---------------------------------
-- Evaluates the real RLS functions. can_see_brand false with an assignment row
-- present means the function is wrong; true here but nothing in the app means a
-- stale client cache, so hard-reload.
select
  apc.display_name                                 as apc,
  b.brand_name,
  tl.display_name                                  as owner_tl,
  public.can_view_brand(b.owner_id, b.id, apc.id)  as can_see_brand,
  (select count(*) from public.reports r where r.brand_id = b.id)                  as reports_on_brand,
  (select count(*) from public.reports r
    where r.brand_id = b.id
      and public.can_view_report(r.brand_id, r.author_id, apc.id))                 as visible_to_apc
from public.profiles apc
join public.brand_assignments ba on ba.user_id = apc.id
join public.brands b             on b.id = ba.brand_id
join public.profiles tl          on tl.id = b.owner_id
where apc.role = 'apc' and apc.deleted_at is null and b.status = 'active'
order by apc.display_name, b.brand_name;
