-- ============================================================
-- WurxOS v2 — Migration 345: the OL brand roll-up counts a GMV Max line that
-- has actually hit its goal.
--
-- ── THE SYMPTOM ────────────────────────────────────────────────────────────
-- An OL opens their incentive details and every curated brand reads 0%, even
-- for brands whose APC and TL are both being paid for hitting that same goal.
-- Both OLs sat at exactly 0/10 brands.
--
-- ── THE CAUSE ──────────────────────────────────────────────────────────────
-- ol_brand_incentive_pct decides whether a brand counts as hit by reading the
-- brand OWNER's incentive items:
--     link_hit = bool_or(brandId matches AND (it->>'completed')::boolean)
-- filtered to sources not in ('attendance','ol_brands','commission_tier').
--
-- gmv_max is not in that exclusion list, so its items are counted — but since
-- migs 339/340 a gmv_max line's `completed` is DERIVED, never stored. It is
-- false at rest by design, and mig 340 deliberately stopped the payout freeze
-- writing it (a stored true was read back here as another person's brand hit
-- and made an OL's pay depend on the order rows were cleared in).
--
-- So the roll-up was asking a flag that is always false. And because 19 of 20
-- OL-curated brands have a gmv_max line as their ONLY brand link, has_link was
-- true and link_hit was false for essentially every brand — a guaranteed 0%.
--
-- ── THE FIX ────────────────────────────────────────────────────────────────
-- Derive it here too, from the same source of truth the incentives page and
-- perf_incentives_score use: brand_monthly_metrics.gmv_achieved against the
-- item's own targetValue, at the same 90% threshold. Non-gmv_max items keep
-- reading their stored flag exactly as before.
--
-- `targetValue > 0` is load-bearing for the same reason it is everywhere else:
-- plans are created with targets at 0 and filled in later, and 0 >= 0 would
-- mark a half-built plan's brand as hit.
--
-- Excluding gmv_max from the roll-up instead was considered and rejected when
-- mig 340 was written: measured live, 19 of 20 OL-curated brands have a gmv_max
-- line as their only link, so excluding it would collapse has_link and drop the
-- whole roll-up into fuzzy name-matching — a far more violent change than the
-- bug. attendance/ol_brands/commission_tier were safe to exclude precisely
-- because they carry no brandId.
--
-- ── MONEY IMPACT: NONE TODAY ───────────────────────────────────────────────
-- Measured on 2026-09-02. Both OLs carry one ol_brands line worth PKR 20,000
-- at a 70% target. This moves them from a false 0% to a true 30% (Arslan) and
-- 50% (Fahad) for both July and August — still short of 70%, so nothing becomes
-- payable. It corrects a misleading figure rather than releasing money. In a
-- month where the brands genuinely perform it will pay, which is the point.
--
-- Both functions are edited IN PLACE via pg_get_functiondef + replace — the
-- technique mig 335 used — because mig 335 already rewrote them this way and
-- retyping their bodies risks silently dropping that change.
-- Idempotent.
-- ============================================================

do $rollup$
declare
  -- The two expressions to replace, and their scope-correct replacements. The
  -- only difference is the brand column in scope: s.brand_id in the pct
  -- function, b.id in the status function.
  v_pct_from constant text :=
    $q$bool_or((it->>'brandId') = s.brand_id::text and (it->>'completed')::boolean is true) as link_hit$q$;
  v_pct_to constant text :=
    $q$bool_or((it->>'brandId') = s.brand_id::text and case
              when it->>'source' = 'gmv_max' then
                (it->>'targetValue' ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$'
                 and (it->>'targetValue')::numeric > 0
                 and coalesce((select mm.gmv_achieved
                                 from public.brand_monthly_metrics mm
                                where mm.brand_id  = s.brand_id
                                  and mm.month_key = p_month), 0)
                     >= (it->>'targetValue')::numeric * 0.9)
              else (it->>'completed')::boolean is true
            end) as link_hit$q$;

  v_st_from constant text :=
    $q$bool_or((it->>'brandId') = b.id::text and (it->>'completed')::boolean is true) as link_hit$q$;
  v_st_to constant text :=
    $q$bool_or((it->>'brandId') = b.id::text and case
              when it->>'source' = 'gmv_max' then
                (it->>'targetValue' ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$'
                 and (it->>'targetValue')::numeric > 0
                 and coalesce((select mm.gmv_achieved
                                 from public.brand_monthly_metrics mm
                                where mm.brand_id  = b.id
                                  and mm.month_key = p_month), 0)
                     >= (it->>'targetValue')::numeric * 0.9)
              else (it->>'completed')::boolean is true
            end) as link_hit$q$;

  v_fn   text;
  v_from text;
  v_to   text;
  v_old  text;
  v_cnt  int;
begin
  foreach v_fn in array array[
    'public.ol_brand_incentive_pct(text, uuid[])',
    'public.ol_brand_incentive_status(uuid, text)'
  ] loop
    if v_fn like '%ol_brand_incentive_pct%' then
      v_from := v_pct_from; v_to := v_pct_to;
    else
      v_from := v_st_from;  v_to := v_st_to;
    end if;

    v_old := pg_get_functiondef(v_fn::regprocedure);

    if position($q$'source' = 'gmv_max'$q$ in v_old) > 0 then
      raise notice 'mig 345: % already derives gmv_max — skipping', v_fn;
      continue;
    end if;

    v_cnt := (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from);
    if v_cnt <> 1 then
      raise exception
        'mig 345: expected exactly one link_hit expression in %, found % — refusing to guess.', v_fn, v_cnt;
    end if;

    execute replace(v_old, v_from, v_to);

    -- Prove the live definition changed, rather than trusting replace().
    if position($q$'source' = 'gmv_max'$q$ in pg_get_functiondef(v_fn::regprocedure)) = 0 then
      raise exception 'mig 345: % was not updated', v_fn;
    end if;
    -- And that nothing else was lost in the process.
    if position($q$not in ('attendance','ol_brands','commission_tier')$q$
                in pg_get_functiondef(v_fn::regprocedure)) = 0 then
      raise exception 'mig 345: % lost the mig 335 source-exclusion list', v_fn;
    end if;
    if position('fuzzy_hit' in pg_get_functiondef(v_fn::regprocedure)) = 0 then
      raise exception 'mig 345: % lost its fuzzy-match fallback', v_fn;
    end if;

    raise notice 'mig 345: % now derives gmv_max completion', v_fn;
  end loop;
end;
$rollup$;


-- ── Behavioural check ───────────────────────────────────────────────────────
-- Computes the new rule INLINE rather than calling ol_brand_incentive_pct.
--
-- Two reasons, both learned the hard way on the first draft of this migration:
--   1. That function's return column is `hits`, not `hit`. The first draft
--      selected b.hit, raised 42703 on every OL, and an `exception when others`
--      swallowed it into a "could not sample" notice — so the migration
--      reported success having verified nothing.
--   2. Even with the name right it would prove nothing. The function opens with
--      an auth.uid()-based role gate, and a migration runs with no JWT, so
--      auth.uid() is NULL and it returns zero rows. The notice would have
--      printed a confident "0 of 0 brands hit = 0" — byte-identical to the very
--      symptom this migration exists to cure.
--
-- So this reproduces the link/hit logic directly and reports real numbers the
-- operator can compare against the header's measured figures.
do $verify$
declare
  v_prev text := to_char((date_trunc('month', (now() at time zone 'Asia/Karachi')::date) - interval '1 month'), 'YYYY-MM');
  r      record;
  v_any  boolean := false;
begin
  for r in
    with sel as (
      select oib.ol_id, ol.display_name, b.id as brand_id, b.owner_id
        from public.ol_incentive_brands oib
        join public.brands b   on b.id  = oib.brand_id and b.status = 'active'
        join public.profiles ol on ol.id = oib.ol_id and ol.is_active = true
    ),
    hit as (
      select s.ol_id, s.display_name,
             coalesce(x.link_hit, false) as is_hit
        from sel s
        cross join lateral (
          select bool_or(
                   (it->>'brandId') = s.brand_id::text
                   and case
                         when it->>'source' = 'gmv_max' then
                           (it->>'targetValue' ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$'
                            and (it->>'targetValue')::numeric > 0
                            and coalesce((select mm.gmv_achieved
                                            from public.brand_monthly_metrics mm
                                           where mm.brand_id  = s.brand_id
                                             and mm.month_key = v_prev), 0)
                                >= (it->>'targetValue')::numeric * 0.9)
                         else (it->>'completed')::boolean is true
                       end) as link_hit
            from public.incentives inc
            cross join lateral jsonb_array_elements(
              coalesce(inc.incentives, '[]'::jsonb) || coalesce(inc.bonuses, '[]'::jsonb)) it
           where inc.user_id = s.owner_id and inc.month = v_prev
             and coalesce(it->>'source','') not in ('attendance','ol_brands','commission_tier')
        ) x
    )
    select display_name,
           count(*) filter (where is_hit)::int as hits,
           count(*)::int                       as total
      from hit
     group by ol_id, display_name
     order by display_name
  loop
    v_any := true;
    -- No literal %% here: plpgsql reads '%%%' left-to-right as literal-then-
    -- placeholder, which prints "%0" rather than "0%". Spelling it out avoids
    -- the ambiguity entirely.
    raise notice 'mig 345: % — % of % curated brands hit in % = % percent',
      r.display_name, r.hits, r.total, v_prev,
      case when r.total > 0 then round(r.hits::numeric / r.total * 100) else 0 end;
  end loop;

  if not v_any then
    raise notice 'mig 345: no OL has curated brands — nothing to sample';
  end if;
end;
$verify$;
