-- ============================================================
-- WurxOS v2 — Migration 337: a benchmark of zero (or blank) means "pay on the
-- whole achieved figure", not "pay nothing".
--
-- Mig 336 refused to pay a line whose benchmark was 0, on the reasoning that an
-- empty box is nearly always a field somebody forgot rather than a deliberate
-- zero. That was my call, not a requirement, and it was the wrong one: a zero
-- benchmark is a real mode. With no benchmark to clear, the commission is a
-- straight percentage of everything achieved.
--
--     benchmark blank/0, achieved $100, 5%  ->  $5
--     benchmark $1,000,  achieved $1,200, 0.5%  ->  $1   (only the excess)
--
-- The arithmetic needed no change for this — `achieved - 0` is already the whole
-- achieved figure. Only the guard did.
--
-- ── THE PART THAT WOULD HAVE MADE THIS A HALF-FIX ───────────────────────────
-- `completed` is not decoration. earnedTotal / calcBreakdown and every payslip
-- total in this app sum `amount` ONLY over items where completed is true
-- (incentivesApi.js earnedTotal). Mig 336's rule was
--
--     completed = benchmark > 0 AND achieved >= benchmark
--
-- so a zero-benchmark line would have computed a real $5, been shown as $5, and
-- then contributed ZERO to the person's pay — the money silently dropping out
-- one layer below where anyone would look. The rule now splits on whether there
-- is a benchmark at all:
--
--     benchmark > 0   ->  completed when achieved >= benchmark   (unchanged)
--     no benchmark    ->  completed when achieved > 0
--
-- which preserves the invariant that actually matters: any line paying more
-- than zero is completed, so its money always reaches the total. Asserted at
-- the bottom of this file over a grid of inputs rather than argued for.
--
-- ── ONE GUARD KEPT ──────────────────────────────────────────────────────────
-- A NEGATIVE benchmark is still floored at 0. `achieved - (-500)` would ADD 500
-- to the excess and pay on money nobody earned, and there is no reading of a
-- negative benchmark that a person meant.
--
-- Nothing to migrate: still zero commission_tier lines in production.
-- Idempotent.
-- ============================================================


-- ══ 1. The calculation ══════════════════════════════════════════════════════
create or replace function public.commission_line_state(
  p_brand     uuid,
  p_month     text,
  p_benchmark numeric,
  p_achieved  numeric,
  p_pct       numeric
) returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  with calc as (
    select
      -- coalesce BEFORE greatest(): greatest() SKIPS nulls rather than
      -- propagating them, so the intent has to be spelled out. The floor at 0
      -- is what stops a negative benchmark inflating the excess.
      greatest(coalesce(p_benchmark, 0), 0)            as bench,
      coalesce(p_achieved, 0)                          as ach,
      least(greatest(coalesce(p_pct, 0), 0), 100)      as pct,
      (select b.currency from public.brands b where b.id = p_brand) as ccy
  ),
  calc2 as (
    select *,
           greatest(ach - bench, 0) as excess,
           public.payout_fx_rate(p_month, ccy) as fx
      from calc
  )
  select jsonb_build_object(
    -- With a benchmark, clearing it is the bar. Without one there is no bar,
    -- so anything achieved at all counts — and must, because the totals only
    -- add up `amount` for completed lines.
    'completed', case when bench > 0 then ach >= bench else ach > 0 end,
    'amount',    case when fx is not null then round(excess * pct / 100.0 * fx) else 0 end
  )
  from calc2;
$$;
revoke all on function public.commission_line_state(uuid, text, numeric, numeric, numeric) from public, anon, authenticated;
grant execute on function public.commission_line_state(uuid, text, numeric, numeric, numeric) to service_role;


-- ══ 2. Payout freeze — the missing-rate refusal loses its benchmark>0 test ══
create or replace function public._inc_freeze_commission_items(
  p_items jsonb, p_month text, p_user uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_missing text;
  v_zero constant jsonb := '{"amount":0,"completed":false}'::jsonb;
  v_num  constant text := '^\s*-?[0-9]+(\.[0-9]+)?\s*$';
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or not exists (select 1 from jsonb_array_elements(p_items) e
                     where e->>'source' = 'commission_tier') then
    return coalesce(p_items, '[]'::jsonb);
  end if;

  -- Refuse rather than freeze real earnings at zero for want of a rate. "Owed
  -- something" is now simply achieved-above-the-floored-benchmark, since a
  -- zero benchmark is a legitimate line that pays on everything.
  select string_agg(distinct b.brand_name || ' (' || coalesce(b.currency, '?') || ')', ', ')
    into v_missing
    from jsonb_array_elements(p_items) e
    join public.brands b
      on b.id = case when e->>'brandId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                     then (e->>'brandId')::uuid end
   where e->>'source' = 'commission_tier'
     and e->>'achievedValue' ~ v_num
     and e->>'commissionPct' ~ v_num
     and (e->>'commissionPct')::numeric > 0
     and (e->>'achievedValue')::numeric
         > greatest(case when e->>'targetValue' ~ v_num then (e->>'targetValue')::numeric else 0 end, 0)
     and public.payout_fx_rate(p_month, b.currency) is null;

  if v_missing is not null then
    raise exception
      'Cannot clear this payout: % is owed commission but there is no exchange rate to PKR for %. Add it under Settings -> Payout Rates, then try again.',
      v_missing, p_month
      using errcode = 'check_violation';
  end if;

  return (
    select coalesce(jsonb_agg(
             case
               when e->>'source' = 'commission_tier'
                    and e->>'brandId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               -- coalesce is load-bearing: commission_line_state is NULL for a
               -- brand that no longer exists (brandId is a soft reference with
               -- no FK), and `jsonb || NULL` is NULL, which would replace the
               -- whole line with a JSON null. Cost real breakage in mig 334.
               then e || coalesce(
                           public.commission_line_state(
                             (e->>'brandId')::uuid,
                             p_month,
                             case when e->>'targetValue'   ~ v_num then (e->>'targetValue')::numeric   else 0 end,
                             case when e->>'achievedValue' ~ v_num then (e->>'achievedValue')::numeric else 0 end,
                             case when e->>'commissionPct' ~ v_num then (e->>'commissionPct')::numeric else 0 end),
                           v_zero)
               when e->>'source' = 'commission_tier'
               then e || v_zero
               else e
             end order by ord
           ), '[]'::jsonb)
      from jsonb_array_elements(p_items) with ordinality as t(e, ord)
  );
end;
$$;
revoke all on function public._inc_freeze_commission_items(jsonb, text, uuid) from public, anon, authenticated;
grant execute on function public._inc_freeze_commission_items(jsonb, text, uuid) to service_role;


-- ══ 3. perf_incentives_score — same completion rule, contract C3 ════════════
create or replace function public.perf_incentives_score(p_user uuid, p_month text)
returns numeric
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_done   int := 0;
  v_total  int := 0;
  v_row    public.incentives%rowtype;
  v_paid   boolean;
  v_pct    numeric;
  v_att_ok boolean := false;   -- overlaid completion for attendance items (non-paid rows)
  v_num    constant text := '^\s*-?[0-9]+(\.[0-9]+)?\s*$';
begin
  select * into v_row from public.incentives where user_id = p_user and month = p_month;
  if not found then return 0; end if;

  v_total := coalesce(jsonb_array_length(v_row.incentives), 0)
           + coalesce(jsonb_array_length(v_row.bonuses), 0);
  if v_total = 0 then return 0; end if;

  v_paid := coalesce(v_row.payout_cleared, false);

  if (not v_paid) and exists (
       select 1 from (
         select e from jsonb_array_elements(coalesce(v_row.incentives, '[]'::jsonb)) as t(e)
         union all
         select e from jsonb_array_elements(coalesce(v_row.bonuses,    '[]'::jsonb)) as t(e)
       ) x(e) where x.e->>'source' = 'attendance'
     ) then
    select b.pct into v_pct
      from public.incentive_attendance_pct(p_month, array[p_user]) b limit 1;
    v_att_ok := (p_month < to_char(now() at time zone 'Asia/Karachi', 'YYYY-MM'))
                and (coalesce(v_pct, 0) / 100.0) >= 0.9;
  end if;

  select count(*) into v_done
    from (
      select e from jsonb_array_elements(coalesce(v_row.incentives, '[]'::jsonb)) as t(e)
      union all
      select e from jsonb_array_elements(coalesce(v_row.bonuses,    '[]'::jsonb)) as t(e)
    ) items(e)
   where case
           when (not v_paid) and (items.e->>'source' = 'attendance') then v_att_ok
           when (not v_paid) and (items.e->>'source' = 'commission_tier') then
             (items.e->>'achievedValue' ~ v_num
              and case
                    when greatest(case when items.e->>'targetValue' ~ v_num
                                       then (items.e->>'targetValue')::numeric else 0 end, 0) > 0
                    then (items.e->>'achievedValue')::numeric
                         >= greatest((items.e->>'targetValue')::numeric, 0)
                    else (items.e->>'achievedValue')::numeric > 0
                  end)
           else coalesce((items.e->>'completed')::boolean, false)
         end;

  return round((v_done::numeric / v_total) * 100);
end;
$$;
revoke execute on function public.perf_incentives_score(uuid, text) from public, anon;
grant  execute on function public.perf_incentives_score(uuid, text) to authenticated, service_role;


-- ══ 4. Self-verification ════════════════════════════════════════════════════
do $verify$
declare
  v_brand uuid;
  v_res   jsonb;
  v_bench numeric;
  v_ach   numeric;
  v_amt   numeric;
  v_done  boolean;
begin
  select id into v_brand from public.brands where status = 'active' and currency = 'USD' limit 1;
  if v_brand is null then raise notice 'mig 337: no active USD brand to exercise; skipping'; return; end if;

  -- A rate has to exist for the money half to be meaningful; use a month that
  -- cannot collide with anything real and clean it up afterwards.
  insert into public.payout_fx_rates (month_key, currency, rate)
  values ('1901-01', 'USD', 100)
  on conflict (month_key, currency) do update set rate = 100;

  -- the newly-allowed mode: no benchmark -> pay on everything
  v_res := public.commission_line_state(v_brand, '1901-01', 0, 100, 5);
  if (v_res->>'amount')::numeric <> 500 then      -- 5% of 100 = 5, x100 = 500
    raise exception 'mig 337: a zero benchmark must pay on the whole achieved figure, got %', v_res;
  end if;
  if (v_res->>'completed')::boolean is not true then
    raise exception 'mig 337: a paying zero-benchmark line must be completed, or its money never reaches the total';
  end if;
  v_res := public.commission_line_state(v_brand, '1901-01', null, 100, 5);
  if (v_res->>'amount')::numeric <> 500 then
    raise exception 'mig 337: a NULL benchmark must behave as zero, got %', v_res;
  end if;

  -- with a benchmark, only the excess, and only above it
  v_res := public.commission_line_state(v_brand, '1901-01', 1000, 1200, 0.5);
  if (v_res->>'amount')::numeric <> 100 then      -- 0.5% of 200 = 1, x100 = 100
    raise exception 'mig 337: benchmarked line should pay on the excess only, got %', v_res;
  end if;
  v_res := public.commission_line_state(v_brand, '1901-01', 1000, 900, 0.5);
  if (v_res->>'amount')::numeric <> 0 or (v_res->>'completed')::boolean is not false then
    raise exception 'mig 337: below the benchmark must pay nothing, got %', v_res;
  end if;

  -- a negative benchmark must never ADD to the excess
  v_res := public.commission_line_state(v_brand, '1901-01', -500, 100, 5);
  if (v_res->>'amount')::numeric <> 500 then
    raise exception 'mig 337: a negative benchmark inflated the excess, got %', v_res;
  end if;

  -- THE INVARIANT, over a grid: anything that pays must also be completed,
  -- because every payslip total sums `amount` only where completed is true.
  foreach v_bench in array array[-100, 0, 1, 50, 100, 1000] loop
    foreach v_ach in array array[0, 1, 50, 100, 1000, 5000] loop
      v_res  := public.commission_line_state(v_brand, '1901-01', v_bench, v_ach, 5);
      v_amt  := (v_res->>'amount')::numeric;
      v_done := (v_res->>'completed')::boolean;
      if v_amt > 0 and not v_done then
        raise exception 'mig 337: benchmark % achieved % pays % but is not completed — the money would vanish from the total',
          v_bench, v_ach, v_amt;
      end if;
      if v_amt < 0 then
        raise exception 'mig 337: benchmark % achieved % produced a NEGATIVE payout %', v_bench, v_ach, v_amt;
      end if;
    end loop;
  end loop;

  delete from public.payout_fx_rates where month_key = '1901-01';
end;
$verify$;
