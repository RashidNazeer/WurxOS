-- ============================================================
-- WurxOS v2 — Migration 340: the GMV Max payout freeze must NOT write
-- `completed` into the item. Derive it from the frozen figure instead.
--
-- ── THE DEFECT IN MIG 339 (mine, caught in review before it did damage) ────
-- Mig 339 made _inc_freeze_gmv_max_items persist `completed` alongside the
-- frozen achievedValue. That looked harmless and matched what the attendance
-- and commission freezes do. It is not harmless, because of one structural
-- difference nobody had to think about before:
--
--   attendance / ol_brands items carry NO brandId.
--   gmv_max items DO.
--
-- ol_brand_incentive_pct (mig 297) decides whether a brand counts as "hit" for
-- an OL's roll-up like this:
--     has_link  = any of the brand OWNER's items carries this brandId
--     link_hit  = any of those items has completed = true
--     is_hit    = has_link ? link_hit : fuzzy-name-match
-- filtered by `source not in ('attendance','ol_brands','commission_tier')`.
-- gmv_max is NOT in that list, so gmv_max items both establish the link and
-- vote on the hit.
--
-- So with mig 339 in place, the stored flag flipped true the moment the brand
-- owner's row was payout-cleared — and _inc_freeze_ol_brands_items (mig 294)
-- freezes the OL's OWN pay by calling ol_brand_incentive_pct. The OL's frozen
-- percentage therefore depended on whether the TL's row happened to be cleared
-- first. inc_reset_and_roll loops rows with no ORDER BY; inc_clear_payout is a
-- manual per-row click. Same data, different pay, decided by click order.
-- This is exactly the class of bug mig 335 §1 was written to remove for
-- commission_tier, reintroduced through a fourth source.
--
-- ── WHY NOT JUST EXCLUDE gmv_max FROM THE ROLL-UP (the mig 335 fix) ────────
-- Because it does not transfer. Measured on 2026-09-02 against live data:
-- 19 of 20 OL-curated brand pairs have a gmv_max line as their ONLY linked
-- item. Excluding gmv_max would flip has_link false for nearly every brand and
-- drop the whole roll-up into the fuzzy name-match fallback — rewriting both
-- OLs' pay far more violently than the bug it fixes. attendance and ol_brands
-- were safe to exclude precisely because they never carried a brandId.
--
-- ── THE FIX ────────────────────────────────────────────────────────────────
-- Put the freeze back to what mig 317 did — write achievedValue ONLY, never
-- `completed`. The stored flag then stays false for every gmv_max item at all
-- times, exactly as it was before mig 339, so ol_brand_incentive_pct and
-- ol_brand_incentive_status are byte-identical to their pre-339 behaviour and
-- no freeze can move another person's pay.
--
-- Completion is instead DERIVED everywhere, for paid and unpaid rows alike:
--   unpaid row → from brand_monthly_metrics.gmv_achieved (the live figure)
--   paid row   → from the item's OWN frozen achievedValue
-- A paid row's achievedValue is immutable, so deriving from it is stable
-- forever and gives precisely the number the payout was based on. Nothing is
-- re-read from a live source for a frozen row.
--
-- Net effect versus mig 339: identical pay and identical Performance scores,
-- minus the order dependence and minus any movement in the OL roll-up.
--
-- Idempotent.
-- ============================================================

-- ── 1. Freeze the figure, never the flag ───────────────────────────────────
create or replace function public._inc_freeze_gmv_max_items(
  p_items jsonb, p_month text, p_user uuid
) returns jsonb
language plpgsql security definer set search_path = public
as $$
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or not exists (select 1 from jsonb_array_elements(p_items) e where e->>'source' = 'gmv_max') then
    return coalesce(p_items, '[]'::jsonb);
  end if;

  return (
    select coalesce(jsonb_agg(
             case
               when e->>'source' = 'gmv_max' and e->>'brandId' is not null then
                 -- achievedValue ONLY. Writing `completed` here would be read
                 -- back by ol_brand_incentive_pct as another person's brand hit.
                 e || jsonb_build_object(
                        'achievedValue',
                        coalesce((select m.gmv_achieved
                                    from public.brand_monthly_metrics m
                                   where m.brand_id  = (e->>'brandId')::uuid
                                     and m.month_key = p_month), 0)
                      )
               else e
             end order by ord
           ), '[]'::jsonb)
      from jsonb_array_elements(p_items) with ordinality as t(e, ord)
  );
end;
$$;
revoke execute on function public._inc_freeze_gmv_max_items(jsonb, text, uuid) from public, anon;
grant  execute on function public._inc_freeze_gmv_max_items(jsonb, text, uuid) to authenticated, service_role;


-- ── 2. perf_incentives_score: derive for PAID rows too ─────────────────────
-- Mig 339's branch only fired when the row was unpaid, because a paid row was
-- expected to carry a frozen `completed`. It no longer does, so a paid month
-- would score every GMV Max line as a miss. The replacement covers both, and
-- takes a paid row's figure from the item itself rather than the live table.
--
-- The search string is the EXACT text mig 339 inserted, so this is a
-- deterministic swap rather than a guess about the function's shape.
do $pillar$
declare
  v_fn constant text := 'public.perf_incentives_score(uuid, text)';
  v_uuid constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

  v_339 constant text :=
$q$when (not v_paid) and (items.e->>'source' = 'gmv_max') then
             (items.e->>'brandId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
              and items.e->>'targetValue' ~ v_num
              and (items.e->>'targetValue')::numeric > 0
              and coalesce((select m.gmv_achieved
                              from public.brand_monthly_metrics m
                             where m.brand_id  = (items.e->>'brandId')::uuid
                               and m.month_key = p_month), 0)
                  >= (items.e->>'targetValue')::numeric * 0.9)
           $q$;

  v_340 constant text :=
$q$when (items.e->>'source' = 'gmv_max') then
             (items.e->>'targetValue' ~ v_num
              and (items.e->>'targetValue')::numeric > 0
              and (case
                     when v_paid then
                       case when items.e->>'achievedValue' ~ v_num
                            then (items.e->>'achievedValue')::numeric else 0 end
                     when items.e->>'brandId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
                       coalesce((select m.gmv_achieved
                                   from public.brand_monthly_metrics m
                                  where m.brand_id  = (items.e->>'brandId')::uuid
                                    and m.month_key = p_month), 0)
                     else 0
                   end) >= (items.e->>'targetValue')::numeric * 0.9)
           $q$;
  v_old text;
begin
  v_old := pg_get_functiondef(v_fn::regprocedure);

  if position(v_340 in v_old) > 0 then
    raise notice 'mig 340: perf_incentives_score already migrated — skipping';
  elsif position(v_339 in v_old) = 0 then
    raise exception
      'mig 340: could not find mig 339''s gmv_max branch in % — refusing to guess. Fix by hand.', v_fn;
  else
    execute replace(v_old, v_339, v_340);

    if position(v_340 in pg_get_functiondef(v_fn::regprocedure)) = 0 then
      raise exception 'mig 340: perf_incentives_score was not updated';
    end if;
    if position($q$'source' = 'attendance'$q$ in pg_get_functiondef(v_fn::regprocedure)) = 0
       or position($q$'source' = 'commission_tier'$q$ in pg_get_functiondef(v_fn::regprocedure)) = 0 then
      raise exception 'mig 340: perf_incentives_score lost one of its existing branches';
    end if;
    raise notice 'mig 340: perf_incentives_score now derives gmv_max for paid rows too';
  end if;
end;
$pillar$;


-- ── 3. Prove the freeze no longer stamps a flag anyone else reads ──────────
do $verify$
declare
  v_brand uuid;
  v_month constant text := '1900-01';
  v_out   jsonb;
begin
  select id into v_brand from public.brands limit 1;
  if v_brand is null then
    raise notice 'mig 340: no brands to test against — skipping behavioural check';
    return;
  end if;

  insert into public.brand_monthly_metrics (brand_id, month_key, gmv_achieved)
  values (v_brand, v_month, 5000)
  on conflict (brand_id, month_key) do update set gmv_achieved = 5000;

  -- Wildly over target, and the freeze must STILL leave completed alone.
  v_out := public._inc_freeze_gmv_max_items(
    jsonb_build_array(jsonb_build_object(
      'source','gmv_max','brandId',v_brand::text,'targetValue',100,'completed',false)),
    v_month, null);

  if (v_out->0->>'achievedValue')::numeric <> 5000 then
    raise exception 'mig 340: achieved not frozen (got %)', v_out->0->>'achievedValue';
  end if;
  if (v_out->0->>'completed')::boolean is distinct from false then
    raise exception
      'mig 340: freeze wrote completed=% — the OL roll-up reads that flag and must never see it flip',
      v_out->0->>'completed';
  end if;

  delete from public.brand_monthly_metrics where brand_id = v_brand and month_key = v_month;
  raise notice 'mig 340: freeze records the figure and leaves `completed` untouched';
end;
$verify$;
