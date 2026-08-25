-- ============================================================
-- WurxOS v2 — Migration 336: Commission Based Tier, rebuilt around a MANUAL
-- benchmark and a commission on the EXCESS.
--
-- Migs 333-335 tied the line to Brand Analytics: the goal was the brand's
-- monthly GMV goal, achieved was the figure an APC types at clock-in, and the
-- commission was a percentage of the WHOLE achieved figure once the goal was
-- passed. The requirement changed. The new shape is entirely hand-entered by
-- an OL and pays only on what is earned ABOVE the benchmark:
--
--     GMV Benchmark   typed by the OL          (targetValue)
--     Achieved        typed by the OL ONLY     (achievedValue)  <- not APC/TL
--     Commission %    typed by the OL          (commissionPct)
--
--     amount = (Achieved - Benchmark) x Commission% x rate-to-PKR
--
-- Worked example, the one this was specified with:
--     benchmark $1,000, achieved $1,200, commission 0.5%
--     -> 0.5% of $200 = $6 -> x 280 = PKR 1,680
--
-- NOTHING TO MIGRATE: verified against production before writing this — there
-- are zero commission_tier items and zero FX rate rows, so no stored figure
-- changes meaning under anyone.
--
-- ── A BENCHMARK OF ZERO PAYS NOTHING, DELIBERATELY ──────────────────────────
-- `Achieved - 0` is the whole achieved figure, i.e. exactly the behaviour this
-- migration exists to remove — and it would arrive silently, whenever somebody
-- left the benchmark blank (the client coerces an empty numeric input to 0, so
-- "unset" and "zero" are the same value by the time it reaches here). So a
-- line pays only when its benchmark is > 0, and the UI says so.
--
-- ── WHAT IS STILL DERIVED ───────────────────────────────────────────────────
-- Only `amount` and `completed`. The benchmark and achieved are now real
-- stored values, so — unlike migs 333-335 — they are NOT blanked at rest and
-- NOT recomputed on read. The amount still has to be derived because the FX
-- rate lives in another table and moves independently, and it is still frozen
-- server-side at payout so a later rate change cannot move a paid figure.
--
-- ── AND THE PART THAT NEEDED A SERVER-SIDE GUARD ────────────────────────────
-- "Achieved will be entered by OL, not APC/TL" is a money rule, and until now
-- nothing in this schema validated WHAT is inside the items JSONB — only who
-- may flip verified/payout_cleared/basic_salary. Any user can PATCH their own
-- incentives row under the own-row RLS branch, so a client-side lock is not a
-- lock. incentives_guard_commission restores the three commission fields from
-- the previous row for anyone who is not Boss/OL/Developer.
--
-- It RESTORES rather than RAISES on purpose: a guard that throws would break
-- an APC's ordinary progress save the moment any field-formatting difference
-- crept in, which is a worse failure than the one being prevented. This way a
-- tampered payload is silently corrected and an honest one is untouched.
--
-- Idempotent.
-- ============================================================


-- ══ 1. Numeric-safe key, so the guard compares 1200 and 1200.0 as equal ═════
create or replace function public._num_key(p text)
returns text
language sql
immutable
as $$
  select case
    when p is null or p = ''                  then '0'
    when p ~ '^-?[0-9]+(\.[0-9]+)?$'          then trim_scale(p::numeric)::text
    else p
  end;
$$;
revoke all on function public._num_key(text) from public, anon;
grant execute on function public._num_key(text) to authenticated, service_role;


-- ══ 2. What one commission line is worth ════════════════════════════════════
-- Returns the JSONB patch to merge onto the item. The clamp and the
-- benchmark-must-be-positive rule live HERE, server-side, so they hold no
-- matter what reaches the database.
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
  with cur as (
    select b.currency from public.brands b where b.id = p_brand
  ),
  calc as (
    select
      -- coalesce BEFORE greatest(): greatest() SKIPS nulls rather than
      -- propagating them, so greatest(null, 0) is 0 and a null achieved would
      -- otherwise sail through as "no excess" only by luck.
      coalesce(p_benchmark, 0) as bench,
      coalesce(p_achieved, 0)  as ach,
      least(greatest(coalesce(p_pct, 0), 0), 100) as pct,
      (select currency from cur) as ccy
  )
  select jsonb_build_object(
    'completed', (bench > 0 and ach >= bench),
    'amount',
      case
        when bench > 0
             and ach > bench
             and public.payout_fx_rate(p_month, ccy) is not null
        then round((ach - bench) * pct / 100.0 * public.payout_fx_rate(p_month, ccy))
        else 0
      end
  )
  from calc;
$$;
revoke all on function public.commission_line_state(uuid, text, numeric, numeric, numeric) from public, anon, authenticated;
grant execute on function public.commission_line_state(uuid, text, numeric, numeric, numeric) to service_role;


-- ══ 3. Payout freeze ════════════════════════════════════════════════════════
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
  -- One definition of "this text is a number I can trust", used for all three
  -- fields so they cannot diverge.
  v_num  constant text := '^\s*-?[0-9]+(\.[0-9]+)?\s*$';
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or not exists (select 1 from jsonb_array_elements(p_items) e
                     where e->>'source' = 'commission_tier') then
    return coalesce(p_items, '[]'::jsonb);
  end if;

  -- Refuse rather than freeze real earnings at zero for want of a rate. Only
  -- lines that would actually PAY count: a line sitting below its benchmark
  -- owes nothing, so a missing rate for it is not worth blocking a month-end
  -- run over.
  select string_agg(distinct b.brand_name || ' (' || coalesce(b.currency, '?') || ')', ', ')
    into v_missing
    from jsonb_array_elements(p_items) e
    join public.brands b
      on b.id = case when e->>'brandId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                     then (e->>'brandId')::uuid end
   where e->>'source' = 'commission_tier'
     and e->>'targetValue'  ~ v_num
     and e->>'achievedValue' ~ v_num
     and (e->>'targetValue')::numeric > 0
     and (e->>'achievedValue')::numeric > (e->>'targetValue')::numeric
     and coalesce(nullif(e->>'commissionPct',''), '0') ~ v_num
     and (e->>'commissionPct')::numeric > 0
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
               -- No usable brand link: nothing can be resolved, so it must not
               -- carry a stale amount into the payout.
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


-- ══ 4. perf_incentives_score — mig 333's version, commission branch rewritten ═
-- A commission line's `completed` is still derived (and so still false at rest),
-- but it now derives from the line's OWN stored numbers instead of a lookup
-- into brand_monthly_metrics. Contract C3 — the SQL composite must equal the
-- page composite — so this has to agree with commissionCompleted() in
-- incentivesApi.js: benchmark > 0 AND achieved >= benchmark.
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

  -- Overlay attendance items only when the row is NON-paid AND actually carries
  -- one (skip the incentive_attendance_pct call otherwise — most rows have none).
  if (not v_paid) and exists (
       select 1 from (
         select e from jsonb_array_elements(coalesce(v_row.incentives, '[]'::jsonb)) as t(e)
         union all
         select e from jsonb_array_elements(coalesce(v_row.bonuses,    '[]'::jsonb)) as t(e)
       ) x(e) where x.e->>'source' = 'attendance'
     ) then
    select b.pct into v_pct
      from public.incentive_attendance_pct(p_month, array[p_user]) b limit 1;
    -- month CLOSED in Asia/Karachi (== serverTime.karachiMonth on the page,
    -- independent of the DB session zone) AND coverage/100 >= 0.9 (== autoComplete).
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
             (    items.e->>'targetValue'   ~ v_num
              and items.e->>'achievedValue' ~ v_num
              and (items.e->>'targetValue')::numeric > 0
              and (items.e->>'achievedValue')::numeric >= (items.e->>'targetValue')::numeric)
           else coalesce((items.e->>'completed')::boolean, false)
         end;

  -- round to INTEGER (0 dp) == JS Math.round((completed / total) * 100).
  return round((v_done::numeric / v_total) * 100);
end;
$$;
revoke execute on function public.perf_incentives_score(uuid, text) from public, anon;
grant  execute on function public.perf_incentives_score(uuid, text) to authenticated, service_role;


-- ══ 5. The client no longer needs any GMV — only the currency and the rate ══
-- Replaces commission_tier_map, which returned gmv_achieved/gmv_target. Those
-- were only ever needed because the old model read the goal from Brand
-- Analytics; nothing does now, so the map stops exposing them at all. Scope is
-- unchanged from mig 335: brands named by a commission line on an incentives
-- row the caller may already read (a restatement of the inc_select policy,
-- which SECURITY DEFINER bypasses).
drop function if exists public.commission_tier_map(text);

create or replace function public.commission_fx_map(p_month text)
returns table (
  brand_id  uuid,
  currency  text,
  fx_rate   numeric,
  fx_month  text
)
language sql
security definer
set search_path = public
stable
as $$
  with visible_rows as (
    select inc.incentives, inc.bonuses
      from public.incentives inc
     where inc.month = p_month
       and (
         inc.user_id = auth.uid()
         or public.is_boss(auth.uid())
         or exists (select 1 from public.profiles p
                     where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
         or exists (select 1 from public.profiles p
                     where p.id = inc.user_id and p.reports_to = auth.uid())
       )
  ),
  named as (
    select distinct (it->>'brandId')::uuid as brand_id
      from visible_rows v
      cross join lateral jsonb_array_elements(
        coalesce(v.incentives, '[]'::jsonb) || coalesce(v.bonuses, '[]'::jsonb)) it
     where it->>'source' = 'commission_tier'
       -- shape-check before the cast: a malformed brandId must not error the
       -- whole page, it just resolves to nothing.
       and it->>'brandId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  )
  select b.id,
         b.currency,
         public.payout_fx_rate(p_month, b.currency),
         case when upper(coalesce(b.currency, '')) = 'PKR' then p_month else (
           select r.month_key from public.payout_fx_rates r
            where r.currency = upper(coalesce(b.currency, ''))
              and r.month_key <= p_month
            order by r.month_key desc limit 1
         ) end
    from named n
    join public.brands b on b.id = n.brand_id;
$$;
revoke all on function public.commission_fx_map(text) from public, anon;
grant execute on function public.commission_fx_map(text) to authenticated;


-- ══ 6. Only Boss/OL may set a commission line's three numbers ═══════════════
-- Restores them from the previous row rather than raising — see the header.
create or replace function public._commission_restore(p_new jsonb, p_old jsonb)
returns jsonb
language sql
immutable
as $$
  with old_c as (
    select e->>'id' as id, e as item
      from jsonb_array_elements(coalesce(p_old, '[]'::jsonb)) e
     where e->>'source' = 'commission_tier' and e->>'id' is not null
  ),
  kept as (
    select
      case
        when e->>'source' <> 'commission_tier' or e->>'source' is null then e
        -- A commission line the previous row did not have: a non-admin cannot
        -- introduce one, so it is dropped.
        when o.item is null then null
        -- Otherwise the three protected numbers (and the brand they are
        -- measured against) come from the previous row, never the payload.
        else e || jsonb_build_object(
               'targetValue',   o.item->'targetValue',
               'achievedValue', o.item->'achievedValue',
               'commissionPct', o.item->'commissionPct',
               'brandId',       o.item->'brandId',
               'brandName',     o.item->'brandName')
      end as item,
      ord
      from jsonb_array_elements(coalesce(p_new, '[]'::jsonb)) with ordinality as t(e, ord)
      left join old_c o on o.id = e->>'id'
  ),
  -- Anything the payload dropped is put back, so a commission line cannot be
  -- deleted by someone who was not allowed to create it.
  restored as (
    select item, ord from kept where item is not null
    union all
    select o.item, 1000000 + row_number() over (order by o.id)
      from old_c o
     where not exists (
       select 1 from jsonb_array_elements(coalesce(p_new, '[]'::jsonb)) e
        where e->>'id' = o.id)
  )
  select coalesce(jsonb_agg(item order by ord), '[]'::jsonb) from restored;
$$;
revoke all on function public._commission_restore(jsonb, jsonb) from public, anon;
grant execute on function public._commission_restore(jsonb, jsonb) to authenticated, service_role;


create or replace function public.incentives_guard_commission()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- service_role is server-only tooling (the payout freeze, backups, the v1
  -- sync). Same bypass as incentives_guard, mig 132.
  if pg_has_role(current_user, 'service_role', 'member') then
    return new;
  end if;

  if public.is_boss(auth.uid())
     or exists (select 1 from public.profiles p
                 where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true) then
    return new;
  end if;

  -- Everyone else: the benchmark, the achieved figure and the percentage are
  -- whatever they already were. An APC or TL saving their own progress touches
  -- none of them, so an honest save is byte-identical and nothing is refused.
  if public._commission_fingerprint(new.incentives) is distinct from public._commission_fingerprint(old.incentives) then
    new.incentives := public._commission_restore(new.incentives, old.incentives);
  end if;
  if public._commission_fingerprint(new.bonuses) is distinct from public._commission_fingerprint(old.bonuses) then
    new.bonuses := public._commission_restore(new.bonuses, old.bonuses);
  end if;

  return new;
end;
$$;

create or replace function public._commission_fingerprint(p_items jsonb)
returns text
language sql
immutable
as $$
  select coalesce(string_agg(
           coalesce(e->>'id', '?') || '|' ||
           public._num_key(e->>'targetValue')   || '|' ||
           public._num_key(e->>'achievedValue') || '|' ||
           public._num_key(e->>'commissionPct') || '|' ||
           coalesce(e->>'brandId', ''),
           E'\n' order by coalesce(e->>'id', '?')), '')
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) e
   where e->>'source' = 'commission_tier';
$$;
revoke all on function public._commission_fingerprint(jsonb) from public, anon;
grant execute on function public._commission_fingerprint(jsonb) to authenticated, service_role;

drop trigger if exists incentives_guard_commission on public.incentives;
create trigger incentives_guard_commission
  before update on public.incentives
  for each row execute function public.incentives_guard_commission();


-- ══ 7. Retire the Brand-Analytics-linked helpers ════════════════════════════
-- Nothing references them once the four functions above are replaced. Dropped
-- rather than left dangling so a future reader cannot wire the old semantics
-- back in by accident, and so no overload ambiguity can arise (mig 324/325).
drop function if exists public._commission_state(uuid, text, numeric);
drop function if exists public.commission_goal_hit(uuid, text);


-- ══ 8. Self-verification ════════════════════════════════════════════════════
do $verify$
declare
  v_clear text := pg_get_functiondef('public.inc_clear_payout(uuid, boolean)'::regprocedure);
  v_roll  text := pg_get_functiondef('public.inc_reset_and_roll(text, text, boolean)'::regprocedure);
  v_perf  text := pg_get_functiondef('public.perf_incentives_score(uuid, text)'::regprocedure);
  v_brand uuid;
  v_res   jsonb;
  v_month text := to_char(now() at time zone 'Asia/Karachi', 'YYYY-MM');
begin
  -- the freeze must still be wired into BOTH payout paths (migs 293/294's lesson)
  if position('_inc_freeze_commission_items' in v_clear) = 0
     or position('_inc_freeze_commission_items' in v_roll) = 0 then
    raise exception 'mig 336: the commission freeze fell out of a payout path';
  end if;
  if position('brand_monthly_metrics' in v_perf) > 0 then
    raise exception 'mig 336: perf_incentives_score still reads Brand Analytics for commission';
  end if;
  if position('commission_tier' in v_perf) = 0 then
    raise exception 'mig 336: perf_incentives_score lost its commission branch';
  end if;

  -- the arithmetic, exercised rather than asserted about
  select id into v_brand from public.brands where status = 'active' and currency = 'USD' limit 1;
  if v_brand is null then raise notice 'mig 336: no active USD brand to exercise; skipping'; return; end if;

  -- no rate set for this month yet -> pays 0 but still counts as completed
  v_res := public.commission_line_state(v_brand, '1900-01', 1000, 1200, 0.5);
  if (v_res->>'completed')::boolean is not true then
    raise exception 'mig 336: achieved above benchmark should complete the line';
  end if;
  if (v_res->>'amount')::numeric <> 0 then
    raise exception 'mig 336: no FX rate must pay 0, got %', v_res->>'amount';
  end if;

  -- a benchmark of zero must never pay on the whole achieved figure
  v_res := public.commission_line_state(v_brand, '1900-01', 0, 1200, 0.5);
  if (v_res->>'amount')::numeric <> 0 or (v_res->>'completed')::boolean is not false then
    raise exception 'mig 336: a zero benchmark paid out (%), which is the bug this replaces', v_res;
  end if;

  -- below the benchmark
  v_res := public.commission_line_state(v_brand, '1900-01', 1000, 900, 0.5);
  if (v_res->>'amount')::numeric <> 0 or (v_res->>'completed')::boolean is not false then
    raise exception 'mig 336: below-benchmark line is not zero, got %', v_res;
  end if;
end;
$verify$;
