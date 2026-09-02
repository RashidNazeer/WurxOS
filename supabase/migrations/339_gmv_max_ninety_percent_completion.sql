-- ============================================================
-- WurxOS v2 — Migration 339: a GMV Max incentive line completes at 90% of the
-- brand's goal, and completes BY ITSELF.
--
-- ── WHAT WAS ACTUALLY WRONG ────────────────────────────────────────────────
-- The ask was "90% should count, not 100%". The truth was worse: a GMV Max line
-- had never completed at ANY percentage. On 2026-09-02 all 49 August lines sat
-- at completed=false, including Apothecary at 615% of target, Inno Supps at
-- 279% and Dr. Harvey's at 129%.
--
-- Two independent reasons, both silent:
--
--   1. `achievedValue` is deliberately NOT stored on a gmv_max line — mig 317
--      derives it at read time from brand_monthly_metrics, and the client blanks
--      it on save. The client's autoComplete() then evaluates 0 / target = 0,
--      so it wrote completed=false every time. The 90% rule already existed in
--      that helper; it was simply never handed a real number.
--
--   2. _inc_freeze_gmv_max_items (mig 317) froze `achievedValue` at payout but
--      never touched `completed`. So the flag stayed false through payout too.
--
-- earnedTotal() and perf_incentives_score both count only items where
-- `completed` is true, so these lines paid nothing and scored nothing, forever.
--
-- ── THE RULE ───────────────────────────────────────────────────────────────
--   completed  ⇔  targetValue > 0  AND  gmv_achieved >= targetValue * 0.9
--
-- `targetValue > 0` is load-bearing, not defensive. Plans are routinely created
-- with the targets at 0 and filled in later (Subhan's 12 lines were created
-- exactly that way — see the ads-manager rollout). Without this clause 0 >= 0
-- is true and every line on a half-built plan would mark itself complete and
-- become payable the moment it was saved. A missing goal must read as "not yet
-- decided", never as "achieved".
--
-- Completion becomes fully DERIVED, like attendance / ol_brands /
-- commission_tier: never stored at rest, recomputed at read, frozen once at
-- payout. That removes the OL's ability to hand-tick a gmv_max line at, say,
-- 85% — deliberate, because a stored `true` cannot be told apart from a stale
-- one after the brand's figure moves, and this is money.
--
-- ── SCOPE (chosen by the Boss) ─────────────────────────────────────────────
-- Money and the Performance incentives pillar. NOT the OL brand roll-up:
-- ol_brand_incentive_pct keeps reading the stored `completed`, which stays
-- false at rest, so its output is byte-identical to before this migration.
-- Brand Analytics goals are untouched — the 90% rule lives only in incentives.
--
-- Applied to August 2026 this completes 20 of 49 lines and makes PKR 112,000
-- payable that previously was not.
--
-- Idempotent.
-- ============================================================

-- ── 1. The payout freeze must record completion, not just the figure ────────
-- Reproduced from mig 317 with `completed` added. Kept as one jsonb_build_object
-- so the achieved figure and the flag derived from it can never disagree.
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
                 e || (
                   select jsonb_build_object(
                            'achievedValue', ach,
                            -- Same rule as everywhere else: a goal of 0 or less
                            -- never completes, whatever was achieved.
                            'completed', (tgt > 0 and ach >= tgt * 0.9)
                          )
                   from (
                     select
                       coalesce((select m.gmv_achieved
                                   from public.brand_monthly_metrics m
                                  where m.brand_id  = (e->>'brandId')::uuid
                                    and m.month_key = p_month), 0)                       as ach,
                       case when e->>'targetValue' ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$'
                            then (e->>'targetValue')::numeric else 0 end                 as tgt
                   ) s
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


-- ── 2. The Performance incentives pillar must derive it too ─────────────────
-- perf_incentives_score is edited IN PLACE via pg_get_functiondef + replace,
-- the technique mig 335 used. Retyping its 60-line body to add one branch would
-- risk changing something else by accident; this cannot.
do $pillar$
declare
  v_fn     constant text := 'public.perf_incentives_score(uuid, text)';
  v_anchor constant text := $q$when (not v_paid) and (items.e->>'source' = 'commission_tier') then$q$;
  v_new_branch constant text :=
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
  v_old text;
  v_cnt int;
begin
  v_old := pg_get_functiondef(v_fn::regprocedure);

  if position($q$'source' = 'gmv_max'$q$ in v_old) > 0 then
    raise notice 'mig 339: perf_incentives_score already derives gmv_max — skipping';
  else
    v_cnt := (length(v_old) - length(replace(v_old, v_anchor, ''))) / length(v_anchor);
    if v_cnt <> 1 then
      raise exception
        'mig 339: expected exactly one commission_tier branch in %, found % — refusing to guess.', v_fn, v_cnt;
    end if;

    execute replace(v_old, v_anchor, v_new_branch || v_anchor);

    if position($q$'source' = 'gmv_max'$q$ in pg_get_functiondef(v_fn::regprocedure)) = 0 then
      raise exception 'mig 339: perf_incentives_score was not updated';
    end if;
    -- The branches it already had must have survived the edit.
    if position($q$'source' = 'attendance'$q$ in pg_get_functiondef(v_fn::regprocedure)) = 0
       or position($q$'source' = 'commission_tier'$q$ in pg_get_functiondef(v_fn::regprocedure)) = 0 then
      raise exception 'mig 339: perf_incentives_score lost one of its existing branches';
    end if;
    raise notice 'mig 339: perf_incentives_score now derives gmv_max completion';
  end if;
end;
$pillar$;


-- ── 3. Prove the rule, including the edge that would cost real money ────────
do $verify$
declare
  v_items  jsonb;
  v_out    jsonb;
  v_brand  uuid;
  v_month  constant text := '1900-01';     -- a month no real row can collide with
  v_done   boolean;
  v_ach    numeric;
begin
  -- A throwaway brand + metrics row, rolled back at the end of this block.
  select id into v_brand from public.brands limit 1;
  if v_brand is null then
    raise notice 'mig 339: no brands to test against — skipping behavioural check';
    return;
  end if;

  insert into public.brand_monthly_metrics (brand_id, month_key, gmv_achieved)
  values (v_brand, v_month, 900)
  on conflict (brand_id, month_key) do update set gmv_achieved = 900;

  -- target 1000, achieved 900 -> exactly 90% -> MUST complete
  v_items := jsonb_build_array(jsonb_build_object(
    'source','gmv_max','brandId',v_brand::text,'targetValue',1000,'completed',false));
  v_out  := public._inc_freeze_gmv_max_items(v_items, v_month, null);
  v_done := (v_out->0->>'completed')::boolean;
  v_ach  := (v_out->0->>'achievedValue')::numeric;
  if v_ach <> 900 then raise exception 'mig 339: achieved not frozen (got %)', v_ach; end if;
  if not v_done then raise exception 'mig 339: exactly 90%% must complete'; end if;

  -- target 1001 -> 89.9% -> must NOT complete
  v_items := jsonb_build_array(jsonb_build_object(
    'source','gmv_max','brandId',v_brand::text,'targetValue',1001,'completed',false));
  v_done := ((public._inc_freeze_gmv_max_items(v_items, v_month, null))->0->>'completed')::boolean;
  if v_done then raise exception 'mig 339: 89.9%% must not complete'; end if;

  -- THE ONE THAT MATTERS: target 0 must never complete, however much was earned.
  v_items := jsonb_build_array(jsonb_build_object(
    'source','gmv_max','brandId',v_brand::text,'targetValue',0,'completed',false));
  v_done := ((public._inc_freeze_gmv_max_items(v_items, v_month, null))->0->>'completed')::boolean;
  if v_done then raise exception 'mig 339: a target of 0 must NEVER auto-complete'; end if;

  -- and a blank/absent target likewise
  v_items := jsonb_build_array(jsonb_build_object(
    'source','gmv_max','brandId',v_brand::text,'targetValue','','completed',false));
  v_done := ((public._inc_freeze_gmv_max_items(v_items, v_month, null))->0->>'completed')::boolean;
  if v_done then raise exception 'mig 339: a blank target must NEVER auto-complete'; end if;

  -- a non-gmv_max item must pass through completely untouched
  v_items := jsonb_build_array(jsonb_build_object(
    'source','attendance','targetValue',100,'completed',false));
  if public._inc_freeze_gmv_max_items(v_items, v_month, null) <> v_items then
    raise exception 'mig 339: freeze altered a non-gmv_max item';
  end if;

  delete from public.brand_monthly_metrics where brand_id = v_brand and month_key = v_month;
  raise notice 'mig 339: all completion rules verified (90%% yes, 89.9%% no, 0-target never)';
end;
$verify$;
