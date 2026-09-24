-- ============================================================
-- WurxOS v2 — Migration 365: a brand's monthly GMV goal drives the target on
-- every "Total Revenue in GMV Max" incentive line for that brand.
--
-- ── THE ASK ────────────────────────────────────────────────────────────────
-- Setting a goal in Brand Analytics should update the GMV-Max incentive for
-- everyone on that brand — APC, Team Lead, Ads Manager, Operations Lead — and
-- when the brand hits the goal, all of them should read as achieved, not just
-- the APC.
--
-- ── WHY THE SECOND HALF IS ALREADY ALMOST TRUE ─────────────────────────────
-- A gmv_max line is already derived from the brand's own figures on every
-- surface that matters:
--
--   achievedValue   brand_monthly_metrics.gmv_achieved, filled at read time,
--                   never stored at rest, frozen at payout        (mig 317)
--   completed       targetValue > 0 AND achieved >= targetValue * 0.9,
--                   derived in the client, in perf_incentives_score (339),
--                   and in the OL roll-up ol_brand_incentive_pct    (345)
--
-- So every holder of a line on one brand already reads the SAME achieved
-- figure. The one thing that is still hand-typed, per person, per line, is
-- `targetValue`. That is the whole reason the roles can disagree: an APC on a
-- 250,000 target completes at 225,000 while their TL, who typed 300,000 into
-- the same line last month, does not. Mig 317 measured the two as identical for
-- all 18 brands carrying a line in 2026-08 — they are MEANT to be the same
-- number, and nothing has ever enforced it.
--
-- This migration makes the brand goal the single source of that number. The
-- completion cascade then needs no new rule at all: same brand figure, same
-- target, same 90% threshold, so APC, TL and Ads Manager complete together, and
-- the OL's roll-up (which derives each brand's hit from the brand OWNER's line,
-- mig 345) follows the same synced target.
--
-- ── WHAT THIS DELIBERATELY DOES NOT DO ─────────────────────────────────────
-- It never CREATES an incentive line. If a TL has no GMV-Max line for a brand,
-- nothing appears for them: a line carries a compensation amount, and inventing
-- money nobody approved is not a sync. The new gmv_max_incentive_links() RPC
-- exists so the OL can SEE who is linked to a brand and add a missing line
-- deliberately.
--
-- It never touches `completed` at rest. Mig 340 established why: a stored true
-- on a gmv_max line is read by the OL roll-up as another person's brand hit,
-- which made an OL's pay depend on the order rows were cleared in. Completion
-- stays derived.
--
-- ── SAFETY, GIVEN THIS MOVES MONEY ─────────────────────────────────────────
--   * Paid rows are never touched. payout_cleared = true is frozen history.
--   * A goal that is absent or <= 0 changes nothing. It must not zero a target:
--     0 means "not decided yet" everywhere in this schema (339/345), and
--     zeroing would silently un-complete live lines.
--   * An item whose `source` is explicitly null is left alone. The form writes
--     null when someone picks Manual entry, and that is a decision (see the
--     comment in IncentiveForm). Only source = 'gmv_max', or a brand line whose
--     source key was never set and whose text matches /gmv\s*max/i (the same
--     rule the client and mig 317 use), is synced.
--   * Every automatic change is written to audit_log. public.incentives has no
--     audit trigger of its own, and mig 346's lesson applies directly: if a
--     money figure starts moving without a human touching it, there has to be
--     a trail. The source change is audited too (bmm_audit, mig 346), so a
--     target can always be explained by the goal edit that caused it.
--   * The BEFORE trigger on incentives is what makes this a real lock rather
--     than a UI courtesy. Mig 336 spelled the reason out: any user can PATCH
--     their own incentives row under the own-row RLS branch, so a read-only
--     input in the form is not enforcement.
--
-- ── IMPACT: NOT MEASURED, AND HERE IS WHY ──────────────────────────────────
-- Migs 317/339/345 each quote figures measured against live data. This one
-- cannot: the dev database holds zero incentives rows and zero
-- brand_monthly_metrics rows, and production was not queried to write it. The
-- backfill below therefore reports what it changed via `raise notice` when it
-- runs, and the guards above are written so that the only rows it can touch are
-- unpaid lines on brands that have a positive goal. Read the notice before
-- trusting the numbers on the page.
--
-- Idempotent. Reversible: drop the two triggers (the targets already written
-- stay, matching the goals they came from).
-- ============================================================

-- ── 1. Is this item a GMV-Max brand line, and for which brand? ──────────────
-- Returns the brand uuid for a line this migration owns, else null. One
-- definition, used by the apply function, the sync, the trigger predicate and
-- the links RPC, so they cannot disagree about what counts.
--
-- The uuid pattern check is not defensive dressing: brandId is free-form JSON
-- and a bad cast inside a trigger would fail an unrelated incentive save. Mig
-- 339 guards the same cast the same way.
create or replace function public._inc_gmv_max_brand(p_item jsonb)
returns uuid
language sql
immutable
as $$
  select case
    when p_item is null or jsonb_typeof(p_item) <> 'object' then null
    when coalesce(p_item->>'brandId', '') !~
         '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then null
    when p_item->>'source' = 'gmv_max' then (p_item->>'brandId')::uuid
    -- `source` key absent = never decided; the client stamps gmv_max on exactly
    -- this condition. An explicit null means Manual was chosen: left alone.
    when not (p_item ? 'source') and coalesce(p_item->>'text', '') ~* 'gmv\s*max'
         then (p_item->>'brandId')::uuid
    else null
  end;
$$;

-- ── 2. Rewrite one items array against the month's goals ────────────────────
-- trim_scale keeps the stored number looking like what the goal field holds
-- (250000, not 250000.00) so the form and every regex-based numeric parser in
-- the incentives path read it back unchanged.
create or replace function public._inc_apply_gmv_max_targets(p_items jsonb, p_month text)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select case
    when p_items is null or jsonb_typeof(p_items) <> 'array' then coalesce(p_items, '[]'::jsonb)
    else (
      select coalesce(jsonb_agg(
               case
                 when g.goal is not null then
                   t.e || jsonb_build_object('source', 'gmv_max',
                                             'targetValue', to_jsonb(trim_scale(g.goal)))
                 else t.e
               end order by t.ord), '[]'::jsonb)
        from jsonb_array_elements(p_items) with ordinality as t(e, ord)
        left join lateral (
          select m.gmv_target as goal
            from public.brand_monthly_metrics m
           where m.brand_id  = public._inc_gmv_max_brand(t.e)
             and m.month_key = p_month
             and m.gmv_target is not null
             and m.gmv_target > 0
        ) g on true
    )
  end;
$$;
revoke all on function public._inc_apply_gmv_max_targets(jsonb, text) from public, anon;

-- ── 3. Push a brand's goal out to every unpaid line on it ───────────────────
-- SECURITY DEFINER because the person setting the goal (Boss, OL or the brand's
-- own TL) must be able to update OTHER people's incentives rows — the APC's
-- line is the whole point. Not granted to authenticated: only the triggers,
-- which already run as the definer, need to call it.
create or replace function public.gmv_max_sync_targets(p_brand uuid, p_month text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows  int := 0;
  r       record;
  v_inc   jsonb;
  v_bon   jsonb;
begin
  if p_brand is null or p_month is null then return 0; end if;

  for r in
    select i.id, i.incentives, i.bonuses
      from public.incentives i
     where i.month = p_month
       and i.payout_cleared = false
       and exists (
         select 1
           from jsonb_array_elements(
                  coalesce(i.incentives, '[]'::jsonb) || coalesce(i.bonuses, '[]'::jsonb)) e
          where public._inc_gmv_max_brand(e) = p_brand)
  loop
    v_inc := public._inc_apply_gmv_max_targets(r.incentives, p_month);
    v_bon := public._inc_apply_gmv_max_targets(r.bonuses,    p_month);

    if v_inc is distinct from r.incentives or v_bon is distinct from r.bonuses then
      update public.incentives
         set incentives = v_inc,
             bonuses    = v_bon
       where id = r.id;

      -- The trail mig 346 would have wanted. `reason` names the mechanism so a
      -- reviewer can tell a sync apart from somebody editing a plan.
      insert into public.audit_log(actor_id, entity_type, entity_id, action, before, after)
      values (
        auth.uid(), 'incentives', r.id, 'update',
        jsonb_build_object('incentives', r.incentives, 'bonuses', r.bonuses),
        jsonb_build_object('incentives', v_inc, 'bonuses', v_bon,
                           'reason', 'gmv_max_target_sync', 'month', p_month, 'brand_id', p_brand)
      );
      v_rows := v_rows + 1;
    end if;
  end loop;

  return v_rows;
end;
$$;
revoke all on function public.gmv_max_sync_targets(uuid, text) from public, anon;

-- ── 4. Setting the goal is what fires it ────────────────────────────────────
create or replace function public.bmm_sync_gmv_max()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only when the goal itself moved to a real, positive figure. Clearing a goal
  -- deliberately does NOT reach back into pay.
  if new.gmv_target is not null and new.gmv_target > 0
     and (tg_op = 'INSERT' or new.gmv_target is distinct from old.gmv_target) then
    perform public.gmv_max_sync_targets(new.brand_id, new.month_key);
  end if;
  return new;
end;
$$;

drop trigger if exists bmm_sync_gmv_max_trg on public.brand_monthly_metrics;
create trigger bmm_sync_gmv_max_trg
  after insert or update of gmv_target on public.brand_monthly_metrics
  for each row execute function public.bmm_sync_gmv_max();

-- ── 5. And saving a plan cannot drift away from it ──────────────────────────
-- Runs last of the three BEFORE triggers on this table (incentives_guard,
-- incentives_guard_commission, then this one — Postgres fires them in name
-- order), so it normalises whatever the earlier guards left.
--
-- Skipping cleared rows also keeps it out of the payout path: inc_clear_payout
-- sets payout_cleared = true first and applies its freezes in a second update,
-- which this trigger then leaves entirely alone.
create or replace function public.inc_sync_gmv_max_targets()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(new.payout_cleared, false) then
    return new;
  end if;
  new.incentives := public._inc_apply_gmv_max_targets(new.incentives, new.month);
  new.bonuses    := public._inc_apply_gmv_max_targets(new.bonuses,    new.month);
  return new;
end;
$$;

drop trigger if exists inc_sync_gmv_max_trg on public.incentives;
create trigger inc_sync_gmv_max_trg
  before insert or update on public.incentives
  for each row execute function public.inc_sync_gmv_max_targets();

-- ── 6. Who is linked to a brand's GMV-Max goal, and are they there yet? ─────
-- Read-only, no compensation figures. This is what lets Brand Analytics show
-- that the TL and the Ads Manager read as achieved alongside the APC, and show
-- when somebody has no line at all — the case this migration refuses to fix by
-- inventing one.
--
-- Visible to Boss, an active OL/Developer, or the brand's owner TL: the same
-- people who may set the goal (migs 260/342), so it reveals nothing they could
-- not already reach.
create or replace function public.gmv_max_incentive_links(p_brand uuid, p_month text)
returns table (
  user_id      uuid,
  display_name text,
  role         text,
  target       numeric,
  achieved     numeric,
  completed    boolean,
  paid         boolean
)
language sql
security definer
set search_path = public
stable
as $$
  with allowed as (
    select public.is_boss(auth.uid())
        or exists (select 1 from public.profiles me
                    where me.id = auth.uid() and me.role in ('ol', 'developer') and me.is_active = true)
        or exists (select 1 from public.brands b
                    where b.id = p_brand and b.owner_id = auth.uid()) as ok
  ),
  ach as (
    select coalesce((select m.gmv_achieved
                       from public.brand_monthly_metrics m
                      where m.brand_id = p_brand and m.month_key = p_month), 0) as v
  )
  select i.user_id,
         p.display_name,
         p.role,
         trim_scale(s.tgt)                             as target,
         trim_scale((select v from ach))               as achieved,
         (s.tgt > 0 and (select v from ach) >= s.tgt * 0.9) as completed,
         i.payout_cleared                              as paid
    from public.incentives i
    join public.profiles p on p.id = i.user_id
    cross join lateral jsonb_array_elements(
      coalesce(i.incentives, '[]'::jsonb) || coalesce(i.bonuses, '[]'::jsonb)) e
    cross join lateral (
      select case when e->>'targetValue' ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$'
                  then (e->>'targetValue')::numeric else 0 end as tgt
    ) s
   where (select ok from allowed)
     and i.month = p_month
     and public._inc_gmv_max_brand(e) = p_brand
   order by p.role, p.display_name;
$$;
revoke all on function public.gmv_max_incentive_links(uuid, text) from public, anon;
grant execute on function public.gmv_max_incentive_links(uuid, text) to authenticated;

-- ── 7. Backfill every unpaid row, and say what changed ──────────────────────
do $backfill$
declare
  v_pairs int := 0;
  v_rows  int := 0;
  r       record;
begin
  for r in
    select distinct m.brand_id, m.month_key
      from public.brand_monthly_metrics m
     where m.gmv_target is not null and m.gmv_target > 0
       and exists (select 1 from public.incentives i
                    where i.month = m.month_key and i.payout_cleared = false)
  loop
    v_pairs := v_pairs + 1;
    v_rows  := v_rows + public.gmv_max_sync_targets(r.brand_id, r.month_key);
  end loop;

  raise notice 'mig 365 backfill: % brand-months scanned, % incentive rows had a target corrected', v_pairs, v_rows;
  if v_rows > 0 then
    raise notice 'mig 365: review those changes in audit_log where entity_type = ''incentives'' and after->>''reason'' = ''gmv_max_target_sync''';
  end if;
end;
$backfill$;

-- ── 8. Verification ─────────────────────────────────────────────────────────
-- Structure, then behaviour on a throwaway brand-month that no real row can
-- collide with, cleaned up afterwards (the shape mig 346 used).
do $verify$
declare
  v_n      int;
  v_brand  uuid;
  v_user   uuid;
  v_month  constant text := '1899-02';
  v_inc    jsonb;
  v_tgt    numeric;
  v_done   boolean;
begin
  select count(*) into v_n from pg_trigger
   where tgrelid = 'public.brand_monthly_metrics'::regclass
     and tgname = 'bmm_sync_gmv_max_trg' and not tgisinternal;
  if v_n <> 1 then raise exception 'mig 365: the goal trigger did not attach'; end if;

  select count(*) into v_n from pg_trigger
   where tgrelid = 'public.incentives'::regclass
     and tgname = 'inc_sync_gmv_max_trg' and not tgisinternal;
  if v_n <> 1 then raise exception 'mig 365: the incentives trigger did not attach — a hand-typed target could still drift'; end if;

  -- Matching rules, stated as assertions so a later edit cannot quietly widen them.
  if public._inc_gmv_max_brand('{"brandId":"11111111-1111-1111-1111-111111111111","source":"gmv_max"}'::jsonb) is null then
    raise exception 'mig 365: a flagged gmv_max line is not being matched';
  end if;
  if public._inc_gmv_max_brand('{"brandId":"11111111-1111-1111-1111-111111111111","text":"Total Revenue in GMV Max"}'::jsonb) is null then
    raise exception 'mig 365: an unflagged GMV Max brand line is not being matched';
  end if;
  if public._inc_gmv_max_brand('{"brandId":"11111111-1111-1111-1111-111111111111","source":null,"text":"Total Revenue in GMV Max"}'::jsonb) is not null then
    raise exception 'mig 365: an explicitly Manual line must be left alone';
  end if;
  if public._inc_gmv_max_brand('{"brandId":"not-a-uuid","source":"gmv_max"}'::jsonb) is not null then
    raise exception 'mig 365: a malformed brandId must not be cast';
  end if;
  if public._inc_gmv_max_brand('{"source":"attendance","text":"Attendance"}'::jsonb) is not null then
    raise exception 'mig 365: a non-brand line must not be matched';
  end if;

  select id into v_brand from public.brands limit 1;
  select id into v_user  from public.profiles limit 1;
  if v_brand is null or v_user is null then
    raise notice 'mig 365: no brand/profile to test against — triggers attached, behaviour unverified';
    return;
  end if;

  -- A plan carrying a line with the WRONG target, then a goal is set.
  insert into public.incentives (user_id, month, basic_salary, incentives, bonuses)
  values (v_user, v_month, 0,
          jsonb_build_array(jsonb_build_object(
            'text', 'Total Revenue in GMV Max', 'brandId', v_brand,
            'source', 'gmv_max', 'targetValue', 999, 'amount', 5000)),
          '[]'::jsonb)
  on conflict (user_id, month) do update set incentives = excluded.incentives;

  insert into public.brand_monthly_metrics (brand_id, month_key, gmv_target, gmv_achieved)
  values (v_brand, v_month, 200000, 190000)
  on conflict (brand_id, month_key) do update
     set gmv_target = 200000, gmv_achieved = 190000;

  select incentives into v_inc from public.incentives where user_id = v_user and month = v_month;
  v_tgt := (v_inc->0->>'targetValue')::numeric;
  if v_tgt <> 200000 then
    raise exception 'mig 365: setting the goal did not reach the incentive line (target = %)', v_tgt;
  end if;

  -- 190000 / 200000 = 95%, so every holder of this line reads as achieved.
  -- Asserted as the rule itself rather than through gmv_max_incentive_links:
  -- that function is gated on auth.uid(), which is null inside a migration, so
  -- calling it here would test the gate and not the arithmetic. The RPC's own
  -- output is covered by the rolled-back dev scenario that accompanies this
  -- migration, which impersonates a real OL.
  select (v_tgt > 0 and 190000 >= v_tgt * 0.9) into v_done;
  if v_done is not true then
    raise exception 'mig 365: 95%% of the goal did not satisfy the completion rule';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace
     where s.nspname = 'public' and p.proname = 'gmv_max_incentive_links'
  ) then
    raise exception 'mig 365: the links RPC was not created';
  end if;

  -- A hand-typed target must not survive a save.
  update public.incentives
     set incentives = jsonb_set(incentives, '{0,targetValue}', '777'::jsonb)
   where user_id = v_user and month = v_month;
  select (incentives->0->>'targetValue')::numeric into v_tgt
    from public.incentives where user_id = v_user and month = v_month;
  if v_tgt <> 200000 then
    raise exception 'mig 365: a hand-typed target drifted from the goal (target = %)', v_tgt;
  end if;

  -- A cleared row is frozen: the same edit sticks.
  update public.incentives set payout_cleared = true where user_id = v_user and month = v_month;
  update public.incentives
     set incentives = jsonb_set(incentives, '{0,targetValue}', '555'::jsonb)
   where user_id = v_user and month = v_month;
  select (incentives->0->>'targetValue')::numeric into v_tgt
    from public.incentives where user_id = v_user and month = v_month;
  if v_tgt <> 555 then
    raise exception 'mig 365: a paid row was rewritten by the sync — frozen history must stay frozen';
  end if;

  delete from public.incentives            where user_id = v_user  and month = v_month;
  delete from public.brand_monthly_metrics where brand_id = v_brand and month_key = v_month;
  delete from public.audit_log
   where entity_type in ('incentives', 'brand_monthly_metrics')
     and coalesce(after->>'month', after->>'month_key', before->>'month', before->>'month_key') = v_month;
  delete from public.audit_log
   where entity_type = 'incentives' and after->>'month' = v_month;

  raise notice 'mig 365: brand GMV goals now drive every GMV-Max incentive target; APC, TL, Ads Manager and the OL roll-up complete together';
end;
$verify$;
