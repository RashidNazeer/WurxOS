-- ============================================================
-- WurxOS v2 — Migration 317: "Total Revenue in GMV Max" achieved is AUTO.
--
-- Today every APC / TL / Ads Manager types the achieved figure for their
-- per-brand GMV-Max item by hand, even though the same number is already in the
-- system: an APC enters each brand's month-to-date GMV at clock-in (mig 311),
-- which writes brand_monthly_metrics.gmv_achieved — the "Achieved" bar in Brand
-- Analytics. Two people typing the same number into two places is how they drift.
--
-- SAME METRIC — verified, not assumed. For all 18 brands carrying a GMV-Max
-- incentive in 2026-08 the incentive TARGET and brand_monthly_metrics.gmv_target
-- are identical, currency included (e.g. Pure Daily Care 250000, Longevity Box
-- £15000). The gmv_max_allocated/used columns are the ad-BUDGET pair and are
-- empty for every brand, so they are NOT the source. gmv_achieved is.
--
-- The pattern is the one already used twice — attendance (mig 235/256) and
-- ol_brands (mig 291/293/294): an item flagged { source: '<kind>' } is filled at
-- READ time, never persisted at rest, and snapshotted server-side at payout.
--
-- ONE DELIBERATE DIFFERENCE: attendance and ol_brands derive `completed` too, so
-- they must money-gate it to a closed month. GMV-Max completion stays MANUAL —
-- a TL/OL still ticks the item — so nothing here ever marks an item complete or
-- pays anyone. This migration only ever writes achievedValue.
--
-- Idempotent. inc_clear_payout / inc_reset_and_roll are reproduced VERBATIM from
-- migs 301 / 294 with one extra freeze wrapped around the existing two.
-- ============================================================

-- ── 1. The source: per-brand achieved for a month, caller-scoped ────
-- APCs/TLs/Ads Managers cannot read brand_monthly_metrics (bmm_all is Boss/OL,
-- plus the ads-manager SELECT from mig 316), so the overlay needs a definer RPC.
-- Scoping is can_view_brand, which already means exactly "the brands this person
-- is on": APC/IPC via brand_assignments, TL via owner_id, Ads Manager via
-- ads_manager_brands, OL/Boss everything. So nobody learns a figure for a brand
-- they couldn't already open.
create or replace function public.gmv_max_achieved_map(p_month text)
returns table (brand_id uuid, achieved numeric)
language sql
security definer
set search_path = public
stable
as $$
  select m.brand_id, m.gmv_achieved
  from public.brand_monthly_metrics m
  join public.brands b on b.id = m.brand_id
  where m.month_key = p_month
    and m.gmv_achieved is not null
    and public.can_view_brand(b.owner_id, b.id, auth.uid());
$$;
revoke all on function public.gmv_max_achieved_map(text) from public, anon;
grant execute on function public.gmv_max_achieved_map(text) to authenticated;

-- ── 2. Flag the existing items ──────────────────────────────────────
-- Match by brandId + /gmv max/i on the text, NOT the exact phrase: the label has
-- real variants in the data ("Total GMV from GMV Max", "Total Revenue in GMV Max
-- (Inno Supps)") and a strict match silently misses live targets — the same trap
-- the TL sync hit. Current month only; paid rows are frozen history, left alone.
with flagged as (
  select i.id,
         coalesce((
           select jsonb_agg(
                    case when e ? 'brandId' and e->>'brandId' is not null and (e->>'text') ~* 'gmv\s*max'
                         then e || '{"source":"gmv_max"}'::jsonb
                         else e end
                    order by ord)
           from jsonb_array_elements(i.incentives) with ordinality as t(e, ord)
         ), '[]'::jsonb) as inc,
         coalesce((
           select jsonb_agg(
                    case when e ? 'brandId' and e->>'brandId' is not null and (e->>'text') ~* 'gmv\s*max'
                         then e || '{"source":"gmv_max"}'::jsonb
                         else e end
                    order by ord)
           from jsonb_array_elements(i.bonuses) with ordinality as t(e, ord)
         ), '[]'::jsonb) as bon
  from public.incentives i
  where i.month = '2026-08'
    and i.payout_cleared = false
)
update public.incentives i
set incentives = f.inc, bonuses = f.bon
from flagged f
where i.id = f.id
  and (i.incentives is distinct from f.inc or i.bonuses is distinct from f.bon);

-- ── 3. Payout freeze ────────────────────────────────────────────────
-- Snapshot the live achieved into the JSONB when the payout is cleared, so a
-- later clock-in entry (or a Boss editing Brand Analytics) can never move a
-- number somebody has already been paid on. Unlike the attendance/ol_brands
-- freezes this does NOT touch `completed` — GMV-Max completion is a human
-- decision and must survive the freeze exactly as the manager left it.
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

-- ── 4a. inc_clear_payout — mig 301 VERBATIM + the third freeze ──────
create or replace function public.inc_clear_payout(p_id uuid, p_cleared boolean)
returns public.incentives
language plpgsql security definer set search_path = public
as $$
declare
  v_me          uuid := auth.uid();
  v_row         public.incentives;
  v_target_role text;
begin
  if not (public.is_boss(v_me) or exists (
    select 1 from public.profiles p where p.id = v_me and p.role in ('ol','developer') and p.is_active = true
  )) then raise exception 'only Boss/OL can clear payout'; end if;

  -- mig 301: an OL / Developer may not clear an OL / Developer / Boss payout.
  select p.role into v_target_role
    from public.incentives i join public.profiles p on p.id = i.user_id
   where i.id = p_id;
  if not public.is_boss(v_me) and v_target_role in ('ol','developer','boss') then
    raise exception 'only Boss can clear OL/admin payout';
  end if;

  update public.incentives
     set payout_cleared = p_cleared
   where id = p_id
   returning * into v_row;
  if not found then raise exception 'incentives row not found'; end if;

  -- FREEZE on turn-on: attendance %, ol-brands % AND per-brand GMV-Max achieved.
  if p_cleared then
    update public.incentives
       set incentives = public._inc_freeze_gmv_max_items(
                          public._inc_freeze_ol_brands_items(
                            public._inc_freeze_attendance_items(incentives, month, user_id), month, user_id), month, user_id),
           bonuses    = public._inc_freeze_gmv_max_items(
                          public._inc_freeze_ol_brands_items(
                            public._inc_freeze_attendance_items(bonuses,    month, user_id), month, user_id), month, user_id)
     where id = p_id
     returning * into v_row;
  end if;

  if p_cleared then
    perform public.emit_notification(
      v_row.user_id, v_me, 'system', 'incentives.paid',
      'Payout cleared',
      'Your ' || v_row.month || ' payout has been cleared.',
      'incentives', v_row.id, '/incentives'
    );
  end if;

  return v_row;
end;
$$;

-- ── 4b. inc_reset_and_roll — mig 294 VERBATIM + the third freeze ────
-- Mig 294's lesson, restated because it cost real money once: a new derived
-- source must be frozen in BOTH payout paths. Reset & Roll is the one the Boss
-- actually uses at month end.
create or replace function public.inc_reset_and_roll(
  p_source text,
  p_target text,
  p_force_clear boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me      uuid := auth.uid();
  v_source  record;
  v_cleared int := 0;
  v_created int := 0;
  v_skipped int := 0;
  v_items   jsonb;
  v_bonuses jsonb;
  v_salary  numeric;
begin
  if not public.is_boss(v_me) then raise exception 'only Boss can reset & roll'; end if;
  if p_source is null or p_target is null then raise exception 'source & target month required'; end if;
  if p_source = p_target then raise exception 'source and target must differ'; end if;

  for v_source in select * from public.incentives where month = p_source loop
    -- Mark source row payout_cleared (if verified or forced) and FREEZE its
    -- attendance, ol_brands AND gmv_max items at the source-month figure.
    if v_source.verified or p_force_clear then
      update public.incentives
         set payout_cleared    = true,
             payout_cleared_by = v_me,
             payout_cleared_at = now(),
             incentives        = public._inc_freeze_gmv_max_items(
                                    public._inc_freeze_ol_brands_items(
                                      public._inc_freeze_attendance_items(incentives, month, user_id), month, user_id), month, user_id),
             bonuses           = public._inc_freeze_gmv_max_items(
                                    public._inc_freeze_ol_brands_items(
                                      public._inc_freeze_attendance_items(bonuses,    month, user_id), month, user_id), month, user_id)
       where id = v_source.id;
      v_cleared := v_cleared + 1;
    else
      v_skipped := v_skipped + 1;
    end if;

    v_items := coalesce((
      select jsonb_agg(
        jsonb_set(
          jsonb_set(it::jsonb, '{achievedValue}', '0'::jsonb),
          '{completed}', 'false'::jsonb
        )
      )
      from jsonb_array_elements(v_source.incentives) it
    ), '[]'::jsonb);

    v_bonuses := coalesce((
      select jsonb_agg(
        jsonb_set(
          jsonb_set(it::jsonb, '{achievedValue}', '0'::jsonb),
          '{completed}', 'false'::jsonb
        )
      )
      from jsonb_array_elements(v_source.bonuses) it
    ), '[]'::jsonb);

    -- Salary source of truth = employee_compensation; fall back to the source
    -- month's snapshot when the user has no comp row yet (mig 189).
    select basic_salary into v_salary
      from public.employee_compensation
     where user_id = v_source.user_id;
    if v_salary is null then v_salary := v_source.basic_salary; end if;

    insert into public.incentives
      (user_id, month, basic_salary, incentives, bonuses, last_updated_by, updated_at)
    values
      (v_source.user_id, p_target, v_salary, v_items, v_bonuses, v_me, now())
    on conflict (user_id, month) do nothing;

    if found then v_created := v_created + 1; end if;
  end loop;

  return jsonb_build_object(
    'cleared', v_cleared,
    'created', v_created,
    'skipped', v_skipped
  );
end;
$$;
