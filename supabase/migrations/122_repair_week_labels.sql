-- ============================================================
-- Migration 122 — Boss-only "Repair Week Labels" utility
--
-- Over time, weekly report labels can drift from the brand's true
-- anchor — e.g. an early report's date was edited to fix a typo,
-- or labels were entered manually before the auto-anchor logic
-- existed. The result: two reports labelled "Week 3" or a "Week 5"
-- that should be "Week 2".
--
-- This RPC walks every weekly report for a brand (or every brand),
-- treats the earliest period_start as the true anchor, and rewrites
-- period_number + period_label accordingly. Labels follow the same
-- format the client uses: "Week N (Mon DD - DD)".
--
-- Boss / Developer only. Returns counts so the UI can show a result.
-- ============================================================

create or replace function public.repair_week_labels(p_brand_id uuid default null)
returns table (brands_processed int, reports_relabelled int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_role text;
  v_brand record;
  v_anchor date;
  v_rep record;
  v_n int;
  v_diff int;
  v_end date;
  v_label text;
  v_relabelled int := 0;
  v_brands int := 0;
  v_month_short text[] := array['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select role into v_actor_role from public.profiles where id = auth.uid();
  if v_actor_role not in ('boss','developer') then
    raise exception 'only Boss / Developer can run repairs';
  end if;

  for v_brand in
    select id from public.brands
    where (p_brand_id is null or id = p_brand_id)
  loop
    -- True anchor = earliest weekly report's period_start.
    select min(period_start) into v_anchor
      from public.reports
     where brand_id = v_brand.id and type = 'weekly';
    if v_anchor is null then continue; end if;

    v_brands := v_brands + 1;

    for v_rep in
      select id, period_start, period_end, period_number, period_label
        from public.reports
       where brand_id = v_brand.id and type = 'weekly'
       order by period_start
    loop
      v_diff := (v_rep.period_start - v_anchor);
      v_n := (v_diff / 7) + 1;
      v_end := coalesce(v_rep.period_end, v_rep.period_start + 6);

      if extract(month from v_rep.period_start) = extract(month from v_end) then
        v_label := 'Week ' || v_n || ' (' ||
                   v_month_short[extract(month from v_rep.period_start)::int] || ' ' ||
                   extract(day from v_rep.period_start)::int || ' - ' ||
                   extract(day from v_end)::int || ')';
      else
        v_label := 'Week ' || v_n || ' (' ||
                   v_month_short[extract(month from v_rep.period_start)::int] || ' ' ||
                   extract(day from v_rep.period_start)::int || ' - ' ||
                   v_month_short[extract(month from v_end)::int] || ' ' ||
                   extract(day from v_end)::int || ')';
      end if;

      if coalesce(v_rep.period_number, -1) <> v_n
         or coalesce(v_rep.period_label, '') <> v_label then
        update public.reports
           set period_number = v_n,
               period_label  = v_label
         where id = v_rep.id;
        v_relabelled := v_relabelled + 1;
      end if;
    end loop;
  end loop;

  brands_processed := v_brands;
  reports_relabelled := v_relabelled;
  return next;
end;
$$;
grant execute on function public.repair_week_labels(uuid) to authenticated;
