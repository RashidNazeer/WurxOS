-- ============================================================
-- WurxOS v2 — Migration 335: two consequences of mig 333 that reach other
-- people's money, found by an adversarial review of it.
--
-- ── 1. A COMMISSION LINE WAS DRAGGING DOWN THE OL BRAND ROLL-UP ─────────────
-- public.ol_brand_incentive_pct / ol_brand_incentive_status (mig 297) answer
-- "did the owning TL hit this brand's GMV target this month" by scanning the
-- TL's own incentive items for a brand-linked one and reading its stored
-- `completed`. They exclude the two derived sources whose stored value is
-- meaningless at rest:
--
--     and coalesce(it->>'source','') not in ('attendance','ol_brands')
--
-- commission_tier is the third such source and was not in that list. So a TL
-- carrying a commission line on a brand contributed an item whose stored
-- `completed` is ALWAYS false — the brand read as missed even when its GMV-Max
-- item was ticked, which lowers the roll-up percentage that the OL's own
-- ol_brands incentive is paid on. Someone else's line, quietly reducing the
-- OL's pay.
--
-- It also made the OL's frozen figure depend on the ORDER rows are frozen in
-- during Reset & Roll, because the commission freeze is the first one that
-- writes completed:true onto an item another user's freeze reads back.
--
-- Rather than re-typing ~100 lines of mig 297 (and risking a transcription
-- slip in a money function), this rewrites the live definitions in place and
-- asserts that the substitution actually happened.
--
-- ── 2. THE PAGE AND THE PAYOUT DISAGREED ON WHICH BRANDS RESOLVE ────────────
-- commission_tier_map was scoped by can_view_brand — "brands this person is
-- on". The payout freeze has no such filter. So for a line naming a brand the
-- viewer cannot open, the page showed a confident 0 while the payout would
-- compute and pay the real figure. That is the worst possible split: nobody
-- can see what they are about to be paid.
--
-- Resolved toward the freeze, because the freeze is right: if an OL has put
-- someone on a commission for a brand, that line IS the authorisation, and the
-- person must be able to see the number their pay depends on. An APC moved off
-- a brand mid-month would otherwise silently lose a commission they had earned.
--
-- The new scope is "brands named by a commission line on an incentives row the
-- caller is allowed to read", which mirrors the inc_select policy. That is
-- also strictly NARROWER than before for everything else: it no longer hands
-- back gmv_target for every brand a person can view, only for brands actually
-- carrying a commission line they can already see.
--
-- Idempotent.
-- ============================================================

-- ── 1. Roll-up: treat commission_tier like the other derived sources ────────
do $rollup$
declare
  v_old   text;
  v_new   text;
  v_from  constant text := $q$not in ('attendance','ol_brands')$q$;
  v_to    constant text := $q$not in ('attendance','ol_brands','commission_tier')$q$;
  v_fn    text;
  v_count int;
begin
  foreach v_fn in array array[
    'public.ol_brand_incentive_pct(text, uuid[])',
    'public.ol_brand_incentive_status(uuid, text)'
  ] loop
    v_old := pg_get_functiondef(v_fn::regprocedure);

    -- Already migrated (re-run) — nothing to do for this one.
    if position(v_to in v_old) > 0 then
      continue;
    end if;

    v_count := (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from);
    if v_count = 0 then
      raise exception
        'mig 335: % does not contain the expected source-exclusion list; refusing to guess. Update this migration by hand.', v_fn;
    end if;

    v_new := replace(v_old, v_from, v_to);
    execute v_new;

    -- Prove the live definition actually changed, rather than trusting replace().
    if position(v_to in pg_get_functiondef(v_fn::regprocedure)) = 0 then
      raise exception 'mig 335: % was not updated', v_fn;
    end if;
    raise notice 'mig 335: % — % exclusion list(s) updated', v_fn, v_count;
  end loop;
end;
$rollup$;


-- ── 2. commission_tier_map: scope to lines the caller can already read ──────
-- SECURITY DEFINER, so RLS on public.incentives does not apply inside and the
-- inc_select predicate has to be restated. It is reproduced here verbatim from
-- mig 033 (self / Boss / active OL-developer / their manager) — if that policy
-- is ever widened, widen this with it.
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
    from named n
    join public.brands b on b.id = n.brand_id
    left join public.brand_monthly_metrics m
           on m.brand_id = b.id and m.month_key = p_month;
$$;
revoke all on function public.commission_tier_map(text) from public, anon;
grant execute on function public.commission_tier_map(text) to authenticated;


-- ── Self-verification ───────────────────────────────────────────────────────
do $verify$
declare
  v_pct    text := pg_get_functiondef('public.ol_brand_incentive_pct(text, uuid[])'::regprocedure);
  v_status text := pg_get_functiondef('public.ol_brand_incentive_status(uuid, text)'::regprocedure);
  v_map    text := pg_get_functiondef('public.commission_tier_map(text)'::regprocedure);
begin
  if position('commission_tier' in v_pct) = 0 then
    raise exception 'mig 335: ol_brand_incentive_pct still counts commission lines';
  end if;
  if position('commission_tier' in v_status) = 0 then
    raise exception 'mig 335: ol_brand_incentive_status still counts commission lines';
  end if;
  -- the roll-up must not have lost the two exclusions it already had
  if position('attendance' in v_pct) = 0 or position('ol_brands' in v_pct) = 0 then
    raise exception 'mig 335: ol_brand_incentive_pct lost an existing exclusion';
  end if;
  if position('can_view_brand' in v_map) > 0 then
    raise exception 'mig 335: commission_tier_map is still scoped by can_view_brand';
  end if;
  if position('reports_to' in v_map) = 0 then
    raise exception 'mig 335: commission_tier_map is missing the inc_select mirror';
  end if;
end;
$verify$;
