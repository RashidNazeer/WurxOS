-- ============================================================
-- 288 — Fix tier_sales_due_for: "column reference \"id\" is ambiguous".
--
-- mig 287's function declares RETURNS TABLE(id uuid, brand_name text, tier text,
-- ...). Those output columns are PL/pgSQL variables, and they collide by name
-- with the brands columns referenced in the query — PL/pgSQL's default
-- variable_conflict = 'error' then rejects the query at runtime. Tell it to
-- resolve such names to the COLUMN (the intended meaning everywhere here).
-- Body is otherwise identical to mig 287.
-- ============================================================
create or replace function public.tier_sales_due_for(p_uid uuid)
returns table (id uuid, brand_name text, tier text, last_sale_date date, deadline date, days_left int)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
declare
  v_role  text;
  v_today date := (now() at time zone 'Asia/Karachi')::date;
begin
  select role into v_role from public.profiles where id = p_uid and is_active = true;
  if v_role is null then return; end if;

  return query
    select b.id, b.brand_name, b.tier, b.last_sale_generated_date,
           (b.last_sale_generated_date + interval '30 days')::date,
           ((b.last_sale_generated_date + interval '30 days')::date - v_today)
      from public.brands b
     where b.status = 'active'
       and b.tier is not null and trim(b.tier) <> '' and lower(b.tier) <> 'unlimited'
       and b.last_sale_generated_date is not null
       and ((b.last_sale_generated_date + interval '30 days')::date - v_today) <= 3
       and (
            v_role in ('boss', 'ol', 'developer')
         or (v_role in ('tl', 'pctl') and b.owner_id = p_uid)
         or (v_role in ('apc', 'ipc') and exists (
               select 1 from public.brand_assignments ba
                where ba.brand_id = b.id and ba.user_id = p_uid))
       )
     order by ((b.last_sale_generated_date + interval '30 days')::date - v_today) asc, b.brand_name;
end;
$$;
