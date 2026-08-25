-- ============================================================
-- WurxOS v2 — Migration 334: three fixes to mig 333, found by reviewing it
-- against the live database rather than by reading it.
--
-- ── 1. A DELETED BRAND DESTROYED THE LINE (the serious one) ─────────────────
-- brandId on an incentive item is a SOFT reference: it is a uuid inside JSONB
-- with no foreign key, so deleting a brand leaves the id behind. Mig 333's
-- freeze then did:
--
--     e || public._commission_state((e->>'brandId')::uuid, ...)
--
-- and _commission_state selects FROM public.brands, so for a brand that no
-- longer exists it returns zero rows, i.e. NULL. In Postgres `jsonb || NULL`
-- is NULL — not "unchanged" — so the whole item was replaced by a JSON null.
--
-- Verified against production before writing this:
--     freeze([{normal line}, {commission on a deleted brand}])
--       -> [{"id":"keepme",...}, null]
--
-- The uuid-shaped guard already there does not help: the id is perfectly
-- well-formed, it just no longer points at anything. Consequences were a lost
-- record of what had been promised, and a null element in an array that
-- earnedTotal/calcBreakdown iterate with `.filter(i => i.completed)` — a
-- TypeError on the incentives page for that month, at payout time.
--
-- Fixed by coalescing to an explicit zero patch, so an unresolvable brand
-- behaves exactly like the unusable-brandId branch next to it: the line
-- survives, keeps its text and its agreed percentage, and pays nothing.
--
-- ── 2. The refusal message named the month where the currency belongs ───────
-- Three % placeholders, only two distinct values, so it read
-- "no 2099-01-to-PKR rate is set for 2099-01". The brand list already carries
-- the currency in brackets, so the second placeholder was never needed.
--
-- ── 3. Two helpers were reachable by any signed-in user ─────────────────────
-- _commission_state and commission_goal_hit were granted to `authenticated`
-- with no brand scoping, so anyone with a login could pass any brand uuid and
-- learn whether it had hit its goal — and with p_pct = 100, read its exact GMV
-- back out of the amount. That is the same shape as the pre-existing
-- _inc_freeze_gmv_max_items leak that mig 333 deliberately avoided repeating,
-- and then reintroduced one function over.
--
-- Nothing in the browser calls either one: the client reads commission_tier_map,
-- which IS scoped by can_view_brand. The only callers are service-role
-- (ai-chat, scripts/composite-parity) and perf_incentives_score, which is
-- SECURITY DEFINER and therefore runs as the owner regardless of these grants.
--
-- Idempotent.
-- ============================================================

-- ── 1 + 2 ───────────────────────────────────────────────────────────────────
create or replace function public._inc_freeze_commission_items(
  p_items jsonb, p_month text, p_user uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_missing text;
  -- What a commission line is worth when it cannot be computed at all. Named
  -- once so the two unresolvable cases below cannot drift apart.
  v_zero constant jsonb := '{"amount":0,"achievedValue":0,"targetValue":0,"completed":false}'::jsonb;
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
      'Cannot clear this payout: % has hit its goal but there is no exchange rate to PKR for %. Add it under Settings -> Payout Rates, then try again.',
      v_missing, p_month
      using errcode = 'check_violation';
  end if;

  return (
    select coalesce(jsonb_agg(
             case
               when e->>'source' = 'commission_tier'
                    and e->>'brandId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               -- coalesce is load-bearing: _commission_state is NULL for a brand
               -- that no longer exists, and `jsonb || NULL` is NULL, which would
               -- replace the entire line with a JSON null.
               then e || coalesce(
                           public._commission_state(
                             (e->>'brandId')::uuid,
                             p_month,
                             -- text -> numeric without letting junk abort the payout
                             case when e->>'commissionPct' ~ '^\s*[0-9]+(\.[0-9]+)?\s*$'
                                  then (e->>'commissionPct')::numeric else 0 end),
                           v_zero)
               -- A commission line with no usable brand link can never be
               -- computed, so it must not carry a stale amount into the payout.
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


-- ── 3 ───────────────────────────────────────────────────────────────────────
revoke execute on function public._commission_state(uuid, text, numeric) from authenticated;
revoke execute on function public.commission_goal_hit(uuid, text)        from authenticated;
grant  execute on function public._commission_state(uuid, text, numeric) to service_role;
grant  execute on function public.commission_goal_hit(uuid, text)        to service_role;


-- ── Self-verification ───────────────────────────────────────────────────────
do $verify$
declare
  v_fn   text := pg_get_functiondef('public._inc_freeze_commission_items(jsonb, text, uuid)'::regprocedure);
  v_res  jsonb;
  v_ghost uuid := '00000000-0000-4000-8000-000000000000';   -- valid uuid, no such brand
begin
  if position('coalesce(' in v_fn) = 0 then
    raise exception 'mig 334: the NULL guard is not in the freeze';
  end if;

  -- The actual regression, exercised rather than asserted about.
  v_res := public._inc_freeze_commission_items(
    jsonb_build_array(
      jsonb_build_object('id', 'keepme', 'text', 'normal line', 'amount', 5000, 'completed', true),
      jsonb_build_object('id', 'ghost', 'source', 'commission_tier',
                         'brandId', v_ghost::text, 'commissionPct', 2, 'amount', 7777)
    ),
    to_char(now() at time zone 'Asia/Karachi', 'YYYY-MM'),
    v_ghost);

  if jsonb_array_length(v_res) <> 2 then
    raise exception 'mig 334: freeze changed the number of items (got %)', jsonb_array_length(v_res);
  end if;
  if jsonb_typeof(v_res->1) <> 'object' then
    raise exception 'mig 334: a commission line on a missing brand is still destroyed (got %)', jsonb_typeof(v_res->1);
  end if;
  if coalesce((v_res->1->>'amount')::numeric, -1) <> 0 then
    raise exception 'mig 334: unresolvable commission line did not fall back to 0 (got %)', v_res->1->>'amount';
  end if;
  if v_res->1->>'commissionPct' is null then
    raise exception 'mig 334: the agreed percentage was lost on an unresolvable line';
  end if;
  if (v_res->0->>'amount')::numeric <> 5000 then
    raise exception 'mig 334: an ordinary line beside it was altered';
  end if;
end;
$verify$;
