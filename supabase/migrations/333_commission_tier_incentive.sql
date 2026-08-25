-- ============================================================
-- WurxOS v2 — Migration 333: "Commission Based Tier" incentive lines.
--
-- A fourth derived source, alongside attendance (235/256), ol_brands (291-296)
-- and gmv_max (317). An OL adds a brand-linked line, flips it to Commission
-- Based Tier, and types ONE number: that person's percentage of the brand's
-- GMV. Everything else computes:
--
--     goal hit?  brand_monthly_metrics.gmv_target is set, > 0,
--                and gmv_achieved >= gmv_target        (for that brand+month)
--     amount  =  gmv_achieved x commissionPct% x FX-to-PKR   (0 when not hit)
--
-- The GMV figure is the one an APC types at clock-in (mig 311), so the money
-- keeps moving daily for the whole month — which is what was asked for. There
-- is deliberately NO month-close money gate here, unlike attendance/ol_brands:
-- those can move DOWN mid-month, month-to-date GMV cannot. Once a goal is
-- crossed it stays crossed; only the amount grows.
--
-- ── WHY AN FX RATE EXISTS AT ALL ────────────────────────────────────────────
-- Every other incentive `amount` in this system is PKR — by convention only,
-- it is not stored anywhere, it is a <span>PKR</span> in the JSX. But GMV is in
-- the CLIENT's currency (brands.currency, mig 280 — 19 USD brands and 1 GBP
-- today). A percentage of GMV is therefore born in dollars, and dropping it
-- into a PKR column is a ~280x under-pay that looks entirely plausible on
-- screen: 5% of $2,000 renders as "100" next to a 5,000 PKR line.
--
-- So the amount is converted, and the rate is per (month, currency) rather than
-- a single live rate — that way last month's arithmetic never silently changes
-- when this month's rate is entered.
--
-- HARD STOP, not a silent zero: if a goal has been hit and no rate exists for
-- that currency, clearing the payout RAISES. Freezing a real commission at zero
-- because nobody filled in a rate is exactly the failure this whole file exists
-- to prevent, and it would be invisible on the payslip.
--
-- ── WHAT THIS FILE DOES NOT DO ──────────────────────────────────────────────
-- No existing row is touched. There are no commission items yet, so there is
-- nothing to backfill and no UPDATE over user data here at all.
--
-- ol_brands' pre-existing under-count in perf_incentives_score is left exactly
-- as it is — fixing it would move live OL performance scores, which is not part
-- of this change.
--
-- Idempotent. inc_clear_payout / inc_reset_and_roll / perf_incentives_score are
-- reproduced from migs 317 / 317 / 256 with the commission additions marked.
-- ============================================================


-- ══ 1. FX rates: (month, currency) -> PKR ═══════════════════════════════════
-- Boss-only to write. This number multiplies real pay for everybody holding a
-- commission line, so it does not belong with the per-brand goals an OL edits.
create table if not exists public.payout_fx_rates (
  month_key  text not null check (month_key ~ '^\d{4}-\d{2}$'),
  currency   text not null check (currency ~ '^[A-Z]{3}$'),
  rate       numeric not null check (rate > 0 and rate <= 1000000),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id),
  primary key (month_key, currency)
);

comment on table public.payout_fx_rates is
  'Month-end conversion rate from a brand currency to PKR, used to pay Commission Based Tier incentive lines. Per-month so a new rate never rewrites a past month.';

alter table public.payout_fx_rates enable row level security;

-- Readable by any signed-in user: the client overlay needs it to show the
-- figure, and a published exchange rate is not sensitive.
drop policy if exists pfx_select on public.payout_fx_rates;
create policy pfx_select on public.payout_fx_rates for select
  using (auth.uid() is not null);

drop policy if exists pfx_write on public.payout_fx_rates;
create policy pfx_write on public.payout_fx_rates for all
  using (public.is_boss(auth.uid()))
  with check (public.is_boss(auth.uid()));

grant select on public.payout_fx_rates to authenticated;
grant insert, update, delete on public.payout_fx_rates to authenticated;


-- Rate lookup: this month's rate, else the most recent EARLIER month's.
-- Carrying the last known rate forward beats returning nothing — a missing rate
-- pays zero, and zero is the silent failure. Which month actually supplied it
-- is returned alongside by commission_tier_map so the UI can say so out loud.
create or replace function public.payout_fx_rate(p_month text, p_currency text)
returns numeric
language sql
security definer
set search_path = public
stable
as $$
  select case
    when upper(coalesce(p_currency, '')) = 'PKR' then 1::numeric
    else (
      select r.rate
        from public.payout_fx_rates r
       where r.currency = upper(coalesce(p_currency, ''))
         and r.month_key <= p_month
       order by r.month_key desc
       limit 1
    )
  end;
$$;
revoke all on function public.payout_fx_rate(text, text) from public, anon;
grant execute on function public.payout_fx_rate(text, text) to authenticated, service_role;


-- ══ 2. The gate, defined ONCE ═══════════════════════════════════════════════
-- Both nullable, and the whole metrics row is DELETED when every metric is
-- cleared (brandMetricsApi.saveBrandMonthlyMetrics), so "no goal" is the normal
-- case, not an edge case. Note what the naive versions do with it:
--     SQL   null >= null            -> NULL -> falls through a CASE to false
--     JS    Number(null) >= Number(null) -> 0 >= 0 -> TRUE, and it pays
-- That divergence would show a brand nobody has configured as earned on the
-- page and unearned at payout. Hence: target must EXIST and be > 0, spelled the
-- same way in both languages (see _commissionHit in incentivesApi.js).
create or replace function public.commission_goal_hit(p_brand uuid, p_month text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
      from public.brand_monthly_metrics m
     where m.brand_id  = p_brand
       and m.month_key = p_month
       and m.gmv_target is not null
       and m.gmv_target > 0
       and coalesce(m.gmv_achieved, 0) >= m.gmv_target
  );
$$;
revoke all on function public.commission_goal_hit(uuid, text) from public, anon;
grant execute on function public.commission_goal_hit(uuid, text) to authenticated, service_role;


-- Everything one commission line is worth, as the JSONB patch to merge onto it.
-- p_pct is CLAMPED to 0-100 here rather than trusted: the items array has no
-- schema and no CHECK, the guard trigger validates who-not-what, and a user can
-- PATCH their own incentives row under the own-row RLS branch. So the number
-- that reaches the payout is bounded server-side no matter what is in the JSON.
create or replace function public._commission_state(p_brand uuid, p_month text, p_pct numeric)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select jsonb_build_object(
    'targetValue',   coalesce(m.gmv_target, 0),
    'achievedValue', coalesce(m.gmv_achieved, 0),
    'completed',     public.commission_goal_hit(p_brand, p_month),
    'amount',        case
                       when public.commission_goal_hit(p_brand, p_month)
                            and public.payout_fx_rate(p_month, b.currency) is not null
                       then round(
                              coalesce(m.gmv_achieved, 0)
                              -- clamp: coalesce FIRST, because least()/greatest()
                              -- skip NULLs instead of propagating them.
                              * least(greatest(coalesce(p_pct, 0), 0), 100) / 100.0
                              * public.payout_fx_rate(p_month, b.currency)
                            )
                       else 0
                     end
  )
  from public.brands b
  left join public.brand_monthly_metrics m
         on m.brand_id = b.id and m.month_key = p_month
  where b.id = p_brand;
$$;
revoke all on function public._commission_state(uuid, text, numeric) from public, anon;
grant execute on function public._commission_state(uuid, text, numeric) to authenticated, service_role;


-- ══ 3. Read scope for the client overlay ════════════════════════════════════
-- Same shape and same scoping predicate as gmv_max_achieved_map (mig 317):
-- can_view_brand is exactly "the brands this person is on", so nobody learns a
-- figure for a brand they could not already open.
create or replace function public.commission_tier_map(p_month text)
returns table (
  brand_id  uuid,
  achieved  numeric,
  target    numeric,
  currency  text,
  fx_rate   numeric,
  fx_month  text
)
language sql
security definer
set search_path = public
stable
as $$
  select b.id,
         coalesce(m.gmv_achieved, 0),
         m.gmv_target,                       -- NULL means "no goal set" — kept
         b.currency,                         -- as NULL, never coalesced to 0
         public.payout_fx_rate(p_month, b.currency),
         case when upper(coalesce(b.currency, '')) = 'PKR' then p_month else (
           select r.month_key from public.payout_fx_rates r
            where r.currency = upper(coalesce(b.currency, ''))
              and r.month_key <= p_month
            order by r.month_key desc limit 1
         ) end
    from public.brands b
    left join public.brand_monthly_metrics m
           on m.brand_id = b.id and m.month_key = p_month
   where public.can_view_brand(b.owner_id, b.id, auth.uid());
$$;
revoke all on function public.commission_tier_map(text) from public, anon;
grant execute on function public.commission_tier_map(text) to authenticated;


-- ══ 4. Payout freeze ════════════════════════════════════════════════════════
-- The first freeze that writes `amount`. The three before it only ever wrote
-- achievedValue/completed/targetValue/suffix, because a human typed the money.
-- Here the money IS the derived value, so it must be snapshotted or a later
-- clock-in entry would move a figure somebody has already been paid.
create or replace function public._inc_freeze_commission_items(
  p_items jsonb, p_month text, p_user uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_missing text;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or not exists (select 1 from jsonb_array_elements(p_items) e
                     where e->>'source' = 'commission_tier') then
    return coalesce(p_items, '[]'::jsonb);
  end if;

  -- Refuse rather than freeze a hit commission at zero for want of a rate.
  select string_agg(distinct b.brand_name || ' (' || coalesce(b.currency, '?') || ')', ', ')
    into v_missing
    from jsonb_array_elements(p_items) e
    join public.brands b
      on b.id = case when e->>'brandId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                     then (e->>'brandId')::uuid end
   where e->>'source' = 'commission_tier'
     and public.commission_goal_hit(b.id, p_month)
     and public.payout_fx_rate(p_month, b.currency) is null;

  if v_missing is not null then
    raise exception
      'Cannot clear this payout: % has hit its goal but no %-to-PKR rate is set for %. Add it under Settings -> Payout Rates, then try again.',
      v_missing, p_month, p_month
      using errcode = 'check_violation';
  end if;

  return (
    select coalesce(jsonb_agg(
             case
               when e->>'source' = 'commission_tier'
                    and e->>'brandId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               then e || public._commission_state(
                           (e->>'brandId')::uuid,
                           p_month,
                           -- text -> numeric without letting junk abort the payout
                           case when e->>'commissionPct' ~ '^\s*[0-9]+(\.[0-9]+)?\s*$'
                                then (e->>'commissionPct')::numeric else 0 end)
               -- A commission line with no usable brand link can never be
               -- computed, so it must not carry a stale amount into the payout.
               when e->>'source' = 'commission_tier'
               then e || '{"amount":0,"achievedValue":0,"completed":false}'::jsonb
               else e
             end order by ord
           ), '[]'::jsonb)
      from jsonb_array_elements(p_items) with ordinality as t(e, ord)
  );
end;
$$;
-- Only ever called from inside the two SECURITY DEFINER payout RPCs, which run
-- as the owner. NOT granted to authenticated: _inc_freeze_gmv_max_items was, and
-- that lets any signed-in user hand it a made-up p_items and read back any
-- brand's figures. Not repeating it here.
revoke all on function public._inc_freeze_commission_items(jsonb, text, uuid) from public, anon, authenticated;
grant execute on function public._inc_freeze_commission_items(jsonb, text, uuid) to service_role;


-- ══ 5. inc_clear_payout — mig 317 VERBATIM + the fourth freeze ══════════════
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

  -- FREEZE on turn-on: attendance %, ol-brands %, per-brand GMV-Max achieved
  -- AND (new) the commission amount + the goal it was measured against.
  if p_cleared then
    update public.incentives
       set incentives = public._inc_freeze_commission_items(
                          public._inc_freeze_gmv_max_items(
                            public._inc_freeze_ol_brands_items(
                              public._inc_freeze_attendance_items(incentives, month, user_id), month, user_id), month, user_id), month, user_id),
           bonuses    = public._inc_freeze_commission_items(
                          public._inc_freeze_gmv_max_items(
                            public._inc_freeze_ol_brands_items(
                              public._inc_freeze_attendance_items(bonuses,    month, user_id), month, user_id), month, user_id), month, user_id)
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


-- ══ 6. inc_reset_and_roll — mig 317 VERBATIM + the fourth freeze ════════════
-- Mig 294's lesson, restated once more because it cost real money: a new
-- derived source must be frozen in BOTH payout paths. Reset & Roll is the one
-- the Boss actually uses at month end, and the Boss UI always passes
-- forceClear:true, so it clears unverified rows too.
--
-- ONE EXTRA CHANGE HERE, and it is not cosmetic: the carry-forward zeroes
-- achievedValue and completed but NOT amount, because for every normal line
-- `amount` is the payout an OL typed and must survive into the new month. A
-- commission line's amount is derived, so for THAT source it must be zeroed as
-- well — otherwise last month's commission rolls forward as this month's flat
-- payable and shows as earned the moment the new month's goal is hit.
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
    -- attendance, ol_brands, gmv_max AND commission items at the source month.
    if v_source.verified or p_force_clear then
      update public.incentives
         set payout_cleared    = true,
             payout_cleared_by = v_me,
             payout_cleared_at = now(),
             incentives        = public._inc_freeze_commission_items(
                                    public._inc_freeze_gmv_max_items(
                                      public._inc_freeze_ol_brands_items(
                                        public._inc_freeze_attendance_items(incentives, month, user_id), month, user_id), month, user_id), month, user_id),
             bonuses           = public._inc_freeze_commission_items(
                                    public._inc_freeze_gmv_max_items(
                                      public._inc_freeze_ol_brands_items(
                                        public._inc_freeze_attendance_items(bonuses,    month, user_id), month, user_id), month, user_id), month, user_id)
       where id = v_source.id;
      v_cleared := v_cleared + 1;
    else
      v_skipped := v_skipped + 1;
    end if;

    -- Carry forward. `with ordinality ... order by ord` is new: jsonb_agg over
    -- jsonb_array_elements has no guaranteed order without it, and the freeze
    -- helpers next door have always pinned it.
    v_items := coalesce((
      select jsonb_agg(
        case when it->>'source' = 'commission_tier'
             then jsonb_set(jsonb_set(jsonb_set(it, '{achievedValue}', '0'::jsonb),
                                      '{completed}', 'false'::jsonb),
                            '{amount}', '0'::jsonb)
             else jsonb_set(jsonb_set(it, '{achievedValue}', '0'::jsonb),
                            '{completed}', 'false'::jsonb)
        end order by ord)
      from jsonb_array_elements(v_source.incentives) with ordinality as t(it, ord)
    ), '[]'::jsonb);

    v_bonuses := coalesce((
      select jsonb_agg(
        case when it->>'source' = 'commission_tier'
             then jsonb_set(jsonb_set(jsonb_set(it, '{achievedValue}', '0'::jsonb),
                                      '{completed}', 'false'::jsonb),
                            '{amount}', '0'::jsonb)
             else jsonb_set(jsonb_set(it, '{achievedValue}', '0'::jsonb),
                            '{completed}', 'false'::jsonb)
        end order by ord)
      from jsonb_array_elements(v_source.bonuses) with ordinality as t(it, ord)
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


-- ══ 7. perf_incentives_score — mig 256 VERBATIM + the commission branch ═════
-- Contract C3: the SQL composite must equal the page composite. A commission
-- item's `completed` is derived and therefore FALSE at rest, exactly like an
-- attendance item's, so counting the stored value here would under-count the
-- Bonus & Incentives pillar against what the Performance page shows.
--
-- ol_brands is knowingly left in the `else` branch, where it has always been.
-- It has the same defect, but correcting it would move live OL scores and that
-- belongs in its own change, not this one.
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
           -- NEW: same reason as attendance — derived, so false at rest.
           -- No month-close gate: crossing the goal is the whole condition.
           when (not v_paid) and (items.e->>'source' = 'commission_tier') then
             public.commission_goal_hit(
               case when items.e->>'brandId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    then (items.e->>'brandId')::uuid end,
               p_month)
           else coalesce((items.e->>'completed')::boolean, false)
         end;

  -- round to INTEGER (0 dp) == JS Math.round((completed / total) * 100).
  return round((v_done::numeric / v_total) * 100);
end;
$$;

revoke execute on function public.perf_incentives_score(uuid, text) from public, anon;
grant  execute on function public.perf_incentives_score(uuid, text) to authenticated, service_role;


-- ══ 8. Self-verification (mig 294's pattern) ════════════════════════════════
-- The freeze being wired into BOTH payout paths is the thing that has silently
-- failed before, so assert it here rather than trusting the edit above.
do $verify$
declare
  v_clear text := pg_get_functiondef('public.inc_clear_payout(uuid, boolean)'::regprocedure);
  v_roll  text := pg_get_functiondef('public.inc_reset_and_roll(text, text, boolean)'::regprocedure);
  v_perf  text := pg_get_functiondef('public.perf_incentives_score(uuid, text)'::regprocedure);
begin
  if position('_inc_freeze_commission_items' in v_clear) = 0 then
    raise exception 'mig 333: inc_clear_payout is missing the commission freeze';
  end if;
  if position('_inc_freeze_commission_items' in v_roll) = 0 then
    raise exception 'mig 333: inc_reset_and_roll is missing the commission freeze';
  end if;
  -- the three older freezes must still be there in both
  if position('_inc_freeze_attendance_items' in v_clear) = 0
     or position('_inc_freeze_ol_brands_items' in v_clear) = 0
     or position('_inc_freeze_gmv_max_items'   in v_clear) = 0 then
    raise exception 'mig 333: inc_clear_payout lost one of the existing freezes';
  end if;
  if position('_inc_freeze_attendance_items' in v_roll) = 0
     or position('_inc_freeze_ol_brands_items' in v_roll) = 0
     or position('_inc_freeze_gmv_max_items'   in v_roll) = 0 then
    raise exception 'mig 333: inc_reset_and_roll lost one of the existing freezes';
  end if;
  -- a commission line must not carry a stale amount into the next month
  if position('''{amount}''' in v_roll) = 0 then
    raise exception 'mig 333: inc_reset_and_roll does not zero a rolled commission amount';
  end if;
  if position('commission_goal_hit' in v_perf) = 0 then
    raise exception 'mig 333: perf_incentives_score is missing the commission branch';
  end if;
  if position('attendance' in v_perf) = 0 then
    raise exception 'mig 333: perf_incentives_score lost the attendance branch';
  end if;
end;
$verify$;
