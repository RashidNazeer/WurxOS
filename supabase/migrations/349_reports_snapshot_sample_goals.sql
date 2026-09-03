-- ============================================================
-- WurxOS v2 — Migration 349: a report freezes the sample goal it was written
-- against, so changing the goal later never rewrites reports already finished.
--
-- ── THE PROBLEM ────────────────────────────────────────────────────────────
-- Sample goals have never been stored on the report. Both report views read
-- brand_products.monthly_sample_goal LIVE, every time someone opens a report
-- (mig 217; reportsApi.js says so outright: "the monthly sample goal is NOT
-- stored here"). So the bar a July report shows is drawn against whatever the
-- goal happens to be TODAY.
--
-- Nobody noticed while the only edits were an APC nudging 500 to 520. Mig 348's
-- brand-level "unlimited" flag makes it obvious and much larger: flipping one
-- switch would blank the sample-goal bars on every report that brand has ever
-- filed, retroactively.
--
-- The Boss's requirement, in their words: set unlimited and all reports created
-- after that are affected; switch back to fixed and the ones created next carry
-- a bar again — and previous reports are not impacted either way.
--
-- ── THE FIX ────────────────────────────────────────────────────────────────
-- reports.sample_goal_snapshot — {unlimited, goals{}, capturedAt} — stamped by
-- a BEFORE trigger, never by the client. The report views prefer it and fall
-- back to a live lookup only when it is absent.
--
-- WHEN IT IS STAMPED: on insert, and on every update WHILE THE REPORT IS STILL
-- A DRAFT. The draft -> submitted update is itself an update from draft, so the
-- last stamp a report receives is the state at the moment it was submitted; it
-- is frozen from then on. Stamping only on INSERT was rejected: a report shell
-- is routinely created before that month's goals are typed in, and it would
-- have frozen an empty goal set forever. A report reopened to draft re-stamps
-- on its next save, which is the right answer for a report being rewritten.
--
-- ── THE BACKFILL IS THE POINT, NOT A TIDY-UP ───────────────────────────────
-- Every one of the 566 existing reports is stamped with the brand's CURRENT
-- goal state. That is byte-for-byte what those reports display today, so the
-- backfill changes nothing on screen — it makes what they display permanent.
-- Without it, "snapshot if present, live if absent" would leave every existing
-- report on the live path, and the very first flip of the unlimited flag would
-- do exactly the retroactive damage this migration exists to prevent.
--
-- The backfill runs with ALL user triggers on `reports` disabled, and BEFORE
-- the new trigger is created. Both matter:
--   * reports_touch_updated_at would stamp all 566 rows as edited today
--   * reports_last_editor_trg (mig 121) would overwrite last_edited_by with
--     auth.uid(), which is NULL in a migration — erasing who really edited each
--     report
--   * reports_audit (mig 028) would write 566 phantom "report updated" rows
--     into audit_log and flood the brand activity panels
--   * reports_block_inactive_brand (mig 115) would reject the rows belonging
--     to inactive brands outright
-- and the new stamping trigger, if it already existed, would copy the OLD null
-- straight back over the backfill for every non-draft report.
-- ALTER TABLE is transactional, so a failure anywhere rolls the disable back.
--
-- Idempotent. Reversible: drop the trigger, the two functions and the column —
-- the views fall back to live lookups, which is today's behaviour.
-- ============================================================

-- ── 1. The frozen copy ──────────────────────────────────────────────────────
alter table public.reports
  add column if not exists sample_goal_snapshot jsonb;

comment on column public.reports.sample_goal_snapshot is
  'The brand sample-goal state this report was written against: '
  '{unlimited: bool, goals: {productIdOrLowercasedName: int}, capturedAt}. '
  'Stamped by reports_stamp_sample_goals() on insert and while draft, then '
  'frozen. Never written by the client.';

-- ── 2. Reading the brand's goal state ───────────────────────────────────────
-- Keyed exactly as the report views match rows: by TikTok Shop product ID
-- (primary — report product names come from Euka and differ from the catalog's)
-- and by trimmed lowercase product name (fallback for catalog entries with no
-- ID). max() rather than last-row-wins so two products sharing a key give a
-- deterministic answer instead of one that depends on scan order.
create or replace function public.brand_sample_goal_snapshot(p_brand_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'unlimited', coalesce(b.unlimited_sample_goal, false),
    'goals', coalesce((
      select jsonb_object_agg(k.key, k.goal)
        from (
          select raw.key, max(raw.goal) as goal
            from (
              select btrim(p.product_id) as key, p.monthly_sample_goal as goal
                from public.brand_products p
               where p.brand_id = p_brand_id
                 and p.monthly_sample_goal is not null
                 and btrim(coalesce(p.product_id, '')) <> ''
              union all
              select lower(btrim(p.product_name)), p.monthly_sample_goal
                from public.brand_products p
               where p.brand_id = p_brand_id
                 and p.monthly_sample_goal is not null
                 and btrim(coalesce(p.product_name, '')) <> ''
            ) raw
           group by raw.key
        ) k
    ), '{}'::jsonb),
    'capturedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  )
    from public.brands b
   where b.id = p_brand_id;
$$;

-- No grant to anyone. The only caller is the trigger below, which is itself
-- SECURITY DEFINER and therefore already runs as the owner — an EXECUTE grant
-- to authenticated would widen the surface for nothing. See mig 348: revoking
-- from PUBLIC alone leaves Supabase's explicit default grant to anon in place.
revoke all on function public.brand_sample_goal_snapshot(uuid) from public;
revoke all on function public.brand_sample_goal_snapshot(uuid) from anon;
revoke all on function public.brand_sample_goal_snapshot(uuid) from authenticated;

-- ── 3. Backfill — before the trigger exists, with the others held off ───────
drop trigger if exists reports_stamp_sample_goals_trg on public.reports;

do $backfill$
declare
  v_rows int;
begin
  select count(*) into v_rows from public.reports where sample_goal_snapshot is null;
  if v_rows = 0 then
    raise notice 'mig 349: every report already carries a snapshot — nothing to backfill';
    return;
  end if;

  alter table public.reports disable trigger user;

  update public.reports r
     set sample_goal_snapshot = public.brand_sample_goal_snapshot(r.brand_id)
   where r.sample_goal_snapshot is null;   -- never a bare UPDATE

  alter table public.reports enable trigger user;

  raise notice 'mig 349: froze the current goal state onto % existing report(s)', v_rows;
end;
$backfill$;

-- ── 4. The stamp ────────────────────────────────────────────────────────────
create or replace function public.reports_stamp_sample_goals()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Past draft, the snapshot is frozen. Assigning old's value rather than
  -- simply returning also means a client cannot post its own snapshot: any
  -- value it sends on a submitted/verified/approved report is discarded.
  if tg_op = 'UPDATE' and coalesce(old.status, 'draft') <> 'draft' then
    new.sample_goal_snapshot := old.sample_goal_snapshot;
    return new;
  end if;

  new.sample_goal_snapshot := public.brand_sample_goal_snapshot(new.brand_id);
  return new;
end;
$$;

create trigger reports_stamp_sample_goals_trg
  before insert or update on public.reports
  for each row execute function public.reports_stamp_sample_goals();

-- ── 5. Verification ─────────────────────────────────────────────────────────
do $verify$
declare
  v_cnt   int;
  v_brand uuid;
  v_snap  jsonb;
begin
  select count(*) into v_cnt
    from information_schema.columns
   where table_schema = 'public' and table_name = 'reports'
     and column_name = 'sample_goal_snapshot';
  if v_cnt <> 1 then
    raise exception 'mig 349: reports.sample_goal_snapshot was not created';
  end if;

  -- The trigger has to fire BEFORE: an AFTER trigger cannot assign to NEW, so
  -- it would attach cleanly and stamp precisely nothing.
  select count(*) into v_cnt
    from pg_trigger
   where tgrelid = 'public.reports'::regclass
     and tgname  = 'reports_stamp_sample_goals_trg'
     and not tgisinternal
     and (tgtype & 2) = 2;            -- BEFORE
  if v_cnt <> 1 then
    raise exception 'mig 349: the stamping trigger is missing or is not a BEFORE trigger';
  end if;

  -- The backfill is load-bearing: a report left on the live path is a report
  -- the next goal change would rewrite.
  select count(*) into v_cnt from public.reports where sample_goal_snapshot is null;
  if v_cnt <> 0 then
    raise exception 'mig 349: % report(s) still have no snapshot and would move with the goal', v_cnt;
  end if;

  -- And the snapshots must have real shape, not an empty husk. Check a brand
  -- that actually has per-product goals.
  select p.brand_id into v_brand
    from public.brand_products p
   where p.monthly_sample_goal is not null
   group by p.brand_id
   limit 1;

  if v_brand is null then
    raise notice 'mig 349: no brand has per-product goals — shape check skipped';
  else
    v_snap := public.brand_sample_goal_snapshot(v_brand);
    if jsonb_typeof(v_snap -> 'unlimited') <> 'boolean' then
      raise exception 'mig 349: snapshot.unlimited is not a boolean';
    end if;
    select count(*) into v_cnt from jsonb_object_keys(coalesce(v_snap -> 'goals', '{}'::jsonb));
    if v_cnt = 0 then
      raise exception 'mig 349: a brand with per-product goals produced an empty goals map';
    end if;
  end if;

  select count(*) into v_cnt
    from public.reports
   where (sample_goal_snapshot ->> 'unlimited')::boolean is true;
  raise notice 'mig 349: sample goals frozen per report — % report(s) carry an unlimited goal', v_cnt;
end;
$verify$;
