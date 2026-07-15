-- ============================================================
-- WurxOS v2 — Migration 256: performance composite parity, sub-pillar /
-- leave anon locks, roster missed-today fix, attendance-incentive FREEZE.
--
-- Six independent-but-related fixes, all idempotent, all in the style of
-- migs 252/253 (SECURITY DEFINER, set search_path=public, revoke public/anon +
-- grant authenticated,service_role, qualify every column). DB is applied by the
-- orchestrator; nothing here is deployed by this file.
--
-- ── A. Close the anon EXECUTE leak on six helper functions ──────────────
-- Postgres grants EXECUTE to PUBLIC by default, so a bare `grant to
-- authenticated` (migs 019/038/055/159) was never a gate — anon holding only
-- the publishable key could read any employee's incentives/flags sub-scores,
-- classify a composite via perf_level, or enumerate anyone's leave consumption
-- by UUID. Same revoke-then-grant pattern mig 252/253 applied to the attendance
-- engine and the composite RPCs.
--
-- ── B. get_performance_composite gains an internal VISIBILITY GATE ──────
-- Even after mig 253 revoked anon, ANY authenticated user could read ANY
-- employee's composite/pillars/warnings by UUID (the function never checked who
-- the caller was relative to p_user). Gate it with the SAME predicate the
-- attendance breakdown uses: boss / self / active ol|developer / direct manager.
-- developer stays in (its demotion is a separate campaign).
--
-- ── C. COMPOSITE PARITY (contract C3) ──────────────────────────────────
-- The Performance PAGE computes the composite in JS (performanceApi.calcComposite
-- over the four pillars) and that is the reference of truth. The SQL RPC was both
-- dead (the page never calls it) and WRONG, so the AI assistant — which DOES read
-- the SQL — reported different numbers than the page. Three concrete SQL bugs vs
-- the JS, all fixed here:
--   * performance pillar multiplied overall_score by 10 ("normalise 0-10→0-100").
--     overall_score is already a 0-100 average (mig 243) so *10 then clamp(100)
--     pinned every rated person's performance pillar at 100. Use overall_score
--     AS-IS (clamped 0-100, null when unrated) — matches calcMetricsAvg's domain.
--   * incentives pillar returned 0 when the user had no plan (or a plan with 0
--     items); JS calcIncentiveScore returns null there and calcComposite DROPS a
--     null pillar (re-normalising the weights). A real 0 dragged the composite
--     down. Now the pillar is DROPPED (null, excluded from the weighted mean)
--     unless an incentives row with >=1 item exists.
--   * flags pillar used base 70 + severity-weighted points; JS calcFlagsScore is
--     base 80, +10 per green, -20 per red, severity LABEL-ONLY, clamp 0-100.
--     perf_flags_score is recreated to match exactly.
-- attendance pillar already equals perf_attendance_score (1-dp exact, mig 252 /
-- OWNER-PERF #33). The composite is the weighted mean over the NON-NULL pillars
-- rounded to an INTEGER (JS Math.round), null while unrated ("Not Rated Yet").
-- get_performance_overview is recreated so it re-resolves against the fixed
-- composite fn (and keeps its own visibility scope + green/red counts).
--
-- ── D. att_adjust_bulk_mark_missed reads missed_dates_PAST (contract C4) ─
-- The Roster "mark missed present" bulk action stamped adjustments for every
-- missed weekday <= today INCLUDING today. A day only becomes genuinely "missed"
-- after it has fully elapsed; stamping today lets a manager backfill a present
-- day the employee could still clock into. missed_dates_past (mig 252) excludes
-- today; the client preview (OWNER-ATTUI) reads the same array, so preview ==
-- what the server writes. Recreated VERBATIM from mig 252 changing ONLY the array.
--
-- ── E. FREEZE attendance-linked incentive items at payout (decision 2 / C1) ─
-- An item flagged { source:'attendance' } is filled at READ time from the live
-- attendance % (never persisted — see stripAttendanceForSave / the mig 256 data
-- cleanup in F). Once the money is PAID, the figure must stop moving: a backdated
-- leave/adjustment edit to a closed month would otherwise silently change an
-- already-paid number. So when a row transitions to payout_cleared=true, SNAPSHOT
-- each attendance item's % into the JSONB (achievedValue + completed frozen).
-- The frontend/edge overlay then skips payout_cleared rows and shows the frozen
-- figure verbatim (contract C1).
--   WHY IN THE RPCs, NOT THE GUARD: incentives_guard (mig 132) `return new`s early
--   for any service_role member — and every SECURITY DEFINER payout RPC runs as a
--   role that IS a service_role member (verified against prod: the one cleared row
--   has a null payout_cleared_at, i.e. the guard's stamp block never ran for it),
--   so a freeze placed in the guard would silently no-op. The two human clear
--   paths — inc_clear_payout and inc_reset_and_roll — are the deterministic freeze
--   points; both call the _inc_freeze_attendance_items helper.
-- Completion uses the SINGLE threshold (contract C2 = incentivesApi.autoComplete):
-- achievedValue/targetValue >= 0.9 with target pinned to 100, i.e. pct >= 90.
--
-- ── F. One-shot data cleanup (finding inc-stale-attendance-writeback) ────
-- Attendance items were historically persisted with a stale read-time
-- achievedValue (e.g. a mid-month 40.9% baked in). For every NON-paid incentives
-- row, null out achievedValue + completed on each attendance item so the read
-- overlay is the only source. payout_cleared rows are LEFT ALONE — their frozen
-- figure is the paid truth. Idempotent (re-running converges to the same value).
-- ============================================================


-- ------------------------------------------------------------
-- A. Anon EXECUTE locks on six helper functions.
--    (Signatures verified against migs 038 / 019+159 / 055.)
-- ------------------------------------------------------------
-- perf_incentives_score is RECREATED in C(0) below (integer-round parity with JS
-- calcIncentiveScore, not mig 038's 1-dp round); its revoke/grant lives there.

revoke execute on function public.perf_level(numeric)                    from public, anon;
grant  execute on function public.perf_level(numeric)                    to authenticated, service_role;

revoke execute on function public.consumed_leaves(uuid, int)             from public, anon;
grant  execute on function public.consumed_leaves(uuid, int)             to authenticated, service_role;

revoke execute on function public.consumed_leaves_month(uuid, int, int)  from public, anon;
grant  execute on function public.consumed_leaves_month(uuid, int, int)  to authenticated, service_role;

revoke execute on function public.is_on_leave(uuid, date)               from public, anon;
grant  execute on function public.is_on_leave(uuid, date)               to authenticated, service_role;
-- perf_flags_score is recreated in C below; its revoke/grant lives there.


-- ------------------------------------------------------------
-- C(0). perf_incentives_score — recreated to equal JS calcIncentiveScore
--   OVER THE READ-TIME OVERLAY (finding perf-inc-stored-vs-overlaid-completed).
--   score = completed_items / total_items * 100, rounded to an INTEGER
--   (Math.round), NOT the 1-dp round of mig 038. Verified against prod: 45 of 66
--   plan rows produce a different value at 1-dp vs integer, so the old 66.7-style
--   pillar both failed composite parity and mis-printed the incentives_score
--   column (the page shows the integer). Still 0 when the row has no items; the
--   composite fn DROPS the pillar entirely when there is no plan (v_has_inc).
--
--   ATTENDANCE-ITEM PARITY: a { source:'attendance' } item's `completed` is
--   deliberately false at rest (stripAttendanceForSave + section F null it), but
--   the Performance page counts the OVERLAID value — applyAttendanceAutofill sets
--   completed only once the month is CLOSED (Asia/Karachi) AND live coverage
--   >= 90 (contract C2, target 100). Counting the stored `false` here would
--   UNDERCOUNT completion for any closed month with attendance >= 90%, breaking
--   contract C3 (SQL composite == page composite) invisibly to the parity harness
--   (which reads stored `completed` on BOTH sides). So reproduce the overlay for
--   attendance items on NON-paid rows. A PAID row is frozen — its attendance
--   items already carry the snapshotted `completed`; trust it verbatim.
-- ------------------------------------------------------------
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
           else coalesce((items.e->>'completed')::boolean, false)
         end;

  -- round to INTEGER (0 dp) == JS Math.round((completed / total) * 100).
  return round((v_done::numeric / v_total) * 100);
end;
$$;

revoke execute on function public.perf_incentives_score(uuid, text) from public, anon;
grant  execute on function public.perf_incentives_score(uuid, text) to authenticated, service_role;


-- ------------------------------------------------------------
-- C(i). perf_flags_score — recreated to equal JS calcFlagsScore EXACTLY.
--   base 80 · +10 per green · -20 per red · severity is a LABEL only · clamp 0-100.
-- Only flags created in the target month count (Karachi-locked timestamptz
-- window, matching the JS month filter). Any non-green type counts as red, so
-- this stays correct if a third type is ever added.
-- ------------------------------------------------------------
create or replace function public.perf_flags_score(p_user uuid, p_month text)
returns numeric
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_green int := 0;
  v_red   int := 0;
  v_start timestamptz := (p_month || '-01')::timestamptz;
  v_end   timestamptz := ((p_month || '-01')::date + interval '1 month')::timestamptz;
begin
  select
    coalesce(count(*) filter (where f.type = 'green'), 0),
    coalesce(count(*) filter (where f.type is distinct from 'green'), 0)
    into v_green, v_red
    from public.performance_flags f
   where f.user_id = p_user
     and f.created_at >= v_start
     and f.created_at <  v_end;

  return greatest(0, least(100, 80 + v_green * 10 - v_red * 20));
end;
$$;

revoke execute on function public.perf_flags_score(uuid, text) from public, anon;
grant  execute on function public.perf_flags_score(uuid, text) to authenticated, service_role;


-- ------------------------------------------------------------
-- B + C(ii). get_performance_composite — visibility gate + full JS parity.
--
-- Returns ZERO ROWS (=> JS null) unless the caller may see p_user, using the
-- SAME predicate as attendance_month_breakdown_bulk (mig 252). Then reproduces
-- performanceApi.calcComposite pillar-for-pillar:
--   perf  = overall_score AS-IS, clamp 0-100, null when unrated  (drop the *10)
--   inc   = perf_incentives_score, but DROPPED unless a plan row with >=1 item
--   att   = perf_attendance_score (1-dp exact)                    (always in)
--   flg   = perf_flags_score (base 80 rule above)                 (always in)
-- composite = round( sum(pillar*weight) / sum(weight_of_present_pillars) ) — an
-- INTEGER (Math.round). Composite/level collapse to null/'not_rated' whenever the
-- performance pillar is null (the "Not Rated Yet" state), unchanged.
-- ------------------------------------------------------------
create or replace function public.get_performance_composite(p_user uuid, p_month text)
returns table (
  user_id           uuid,
  month             text,
  performance_score numeric,
  incentives_score  numeric,
  attendance_score  numeric,
  flags_score       numeric,
  composite_score   numeric,
  level             text,
  warning_count     int
)
language plpgsql
security definer
set search_path = public
stable
as $$
#variable_conflict use_column
declare
  v_uid       uuid := auth.uid();
  -- service_role / direct-psql bypass — IDENTICAL to mig 252's
  -- attendance_month_breakdown_bulk. ai-chat's admin client is a pure
  -- service_role client with NO forwarded user JWT, so auth.uid() is NULL for it;
  -- without this the visibility gate returns zero rows and get_performance falls
  -- back to the manager-metrics avg, silently reintroducing the metrics-vs-
  -- composite divergence contract C3 exists to eliminate. service_role already
  -- bypasses RLS entirely, so this widens nothing a service caller couldn't see.
  v_svc       boolean := coalesce(
                 nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', ''
               ) = 'service_role'
               or session_user in ('postgres', 'supabase_admin');
  v_can_see   boolean;
  v_cfg       public.performance_config%rowtype;
  v_perf_raw  numeric;
  v_perf      numeric;
  v_inc       numeric;
  v_att       numeric;
  v_flg       numeric;
  v_has_inc   boolean := false;
  v_num       numeric := 0;
  v_den       numeric := 0;
  v_composite numeric;
  v_warnings  int;
begin
  -- VISIBILITY GATE (finding perf-composite-no-target-gate). Same role set as
  -- the attendance breakdown: boss / self / active ol|developer / direct manager.
  v_can_see := v_svc
    or public.is_boss(v_uid)
    or v_uid = p_user
    or exists (
         select 1 from public.profiles p
          where p.id = v_uid
            and p.role in ('ol', 'developer')
            and p.is_active = true
            and p.deleted_at is null
       )
    or exists (
         select 1 from public.profiles t
          where t.id = p_user
            and t.reports_to = v_uid
       );
  if (v_uid is null and not v_svc) or not v_can_see then
    return;
  end if;

  select * into v_cfg from public.performance_config where id = 1;

  -- Performance pillar: overall_score, NO *10 (that was the bug — overall_score is
  -- already the 0-100 metric average, mig 243). ROUNDED to an integer to match JS
  -- calcMetricsAvg = Math.round(avg): overall_score is the EXACT (unrounded) mean,
  -- and 44 of 80 prod rows are non-integer, so an unrounded pillar fails parity.
  -- null (no rating row) => "Not Rated Yet" => composite null below.
  select pr.overall_score into v_perf_raw
    from public.performance_ratings pr
   where pr.user_id = p_user and pr.month = p_month;
  if v_perf_raw is null then
    v_perf := null;
  else
    v_perf := least(100, greatest(0, round(v_perf_raw)));
  end if;

  -- Incentives pillar: only counted when a plan row with >=1 item exists
  -- (else DROPPED == JS calcIncentiveScore returning null).
  select exists (
    select 1 from public.incentives i
     where i.user_id = p_user
       and i.month = p_month
       and (coalesce(jsonb_array_length(i.incentives), 0)
          + coalesce(jsonb_array_length(i.bonuses), 0)) >= 1
  ) into v_has_inc;
  if v_has_inc then
    v_inc := least(100, greatest(0, coalesce(public.perf_incentives_score(p_user, p_month), 0)));
  else
    v_inc := null;   -- dropped from the weighted mean AND rendered '—'
  end if;

  v_att := least(100, greatest(0, coalesce(public.perf_attendance_score(p_user, p_month), 0)));
  v_flg := least(100, greatest(0, coalesce(public.perf_flags_score(p_user, p_month), 0)));

  -- Composite == calcComposite: weighted mean over the pillars that are present.
  if v_perf is null then
    v_composite := null;                       -- Not Rated Yet
  else
    v_num := v_perf * v_cfg.weight_performance;
    v_den := v_cfg.weight_performance;
    if v_inc is not null then
      v_num := v_num + v_inc * v_cfg.weight_incentives;
      v_den := v_den + v_cfg.weight_incentives;
    end if;
    v_num := v_num + v_att * v_cfg.weight_attendance;
    v_den := v_den + v_cfg.weight_attendance;
    v_num := v_num + v_flg * v_cfg.weight_flags;
    v_den := v_den + v_cfg.weight_flags;
    if v_den > 0 then
      -- round(...) with no scale = round to integer, matching JS Math.round.
      -- The clamp is a belt-and-braces no-op (every pillar is already 0-100).
      v_composite := round(least(100, greatest(0, v_num / v_den)));
    else
      v_composite := 0;                        -- calcComposite: totalWeight 0 -> 0
    end if;
  end if;

  select count(*) into v_warnings
    from public.performance_warnings pw
   where pw.user_id = p_user;

  return query select
    p_user,
    p_month,
    v_perf,
    v_inc,
    v_att,
    v_flg,
    v_composite,
    public.perf_level(v_composite),
    v_warnings;
end;
$$;

revoke execute on function public.get_performance_composite(uuid, text) from public, anon;
grant  execute on function public.get_performance_composite(uuid, text) to authenticated, service_role;


-- ------------------------------------------------------------
-- C(iii). get_performance_overview — recreated so its per-row composite/pillars
-- re-resolve against the fixed get_performance_composite. Body is otherwise the
-- authoritative mig 040 definition (visibility scope + month-windowed green/red
-- flag counts) unchanged.
-- ------------------------------------------------------------
create or replace function public.get_performance_overview(p_month text)
returns table (
  user_id           uuid,
  display_name      text,
  role              text,
  avatar_url        text,
  performance_score numeric,
  incentives_score  numeric,
  attendance_score  numeric,
  flags_score       numeric,
  composite_score   numeric,
  level             text,
  green_flags       int,
  red_flags         int,
  warning_count     int
)
language plpgsql
security definer
set search_path = public
stable
as $$
#variable_conflict use_column
declare
  v_caller uuid := auth.uid();
  -- Same service_role / direct-psql bypass as get_performance_composite. Not
  -- exercised by the authenticated frontend today, but keeps the two functions
  -- consistent so a future service_role caller can't silently get zero rows.
  v_svc    boolean := coalesce(
               nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', ''
             ) = 'service_role'
             or session_user in ('postgres', 'supabase_admin');
  v_is_mgr bool := public.is_boss(v_caller)
                  or exists (select 1 from public.profiles p where p.id = v_caller and p.role in ('ol','developer','tl','pctl') and p.is_active);
  v_start  timestamptz := (p_month || '-01')::timestamptz;
  v_end    timestamptz := ((p_month || '-01')::date + interval '1 month')::timestamptz;
begin
  if (v_caller is null and not v_svc) or not (v_svc or v_is_mgr) then
    return;
  end if;

  return query
  with scope as (
    select p.id, p.display_name, p.role, p.avatar_url
      from public.profiles p
     where p.is_active = true
       and (
         v_svc
         or public.is_boss(v_caller)
         or exists (select 1 from public.profiles me where me.id = v_caller and me.role in ('ol','developer'))
         or p.reports_to = v_caller
       )
  ),
  comp as (
    select s.id,
           s.display_name,
           s.role,
           s.avatar_url,
           c.performance_score,
           c.incentives_score,
           c.attendance_score,
           c.flags_score,
           c.composite_score,
           c.level,
           c.warning_count
      from scope s
      cross join lateral public.get_performance_composite(s.id, p_month) c
  )
  select
    c.id,
    c.display_name,
    c.role,
    c.avatar_url,
    c.performance_score,
    c.incentives_score,
    c.attendance_score,
    c.flags_score,
    c.composite_score,
    c.level,
    coalesce((select count(*)::int from public.performance_flags f
              where f.user_id = c.id and f.type = 'green'
                and f.created_at >= v_start and f.created_at < v_end), 0),
    coalesce((select count(*)::int from public.performance_flags f
              where f.user_id = c.id and f.type = 'red'
                and f.created_at >= v_start and f.created_at < v_end), 0),
    c.warning_count
  from comp c
  order by
    (c.composite_score is null),
    c.composite_score desc,
    c.display_name asc;
end;
$$;

revoke execute on function public.get_performance_overview(text) from public, anon;
grant  execute on function public.get_performance_overview(text) to authenticated, service_role;


-- ------------------------------------------------------------
-- D. att_adjust_bulk_mark_missed — VERBATIM from mig 252, changing ONLY the
-- insert subquery source array missed_dates -> missed_dates_past (contract C4).
-- Actor gate, _adjust_can_act, notification, on-conflict, OUT names unchanged.
-- ------------------------------------------------------------
create or replace function public.att_adjust_bulk_mark_missed(
  p_month    text,
  p_user_ids uuid[],
  p_note     text default null
) returns table (users_touched int, days_added int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id    uuid := auth.uid();
  v_actor_role  text;
  v_actor_name  text;
  v_uid         uuid;
  v_target_role text;
  v_user_added  int;
  v_total_added int := 0;
  v_users       int := 0;
  v_note        text := nullif(trim(coalesce(p_note, '')), '');
begin
  if v_actor_id is null then raise exception 'not authenticated'; end if;
  select p.role, p.display_name into v_actor_role, v_actor_name
    from public.profiles p where p.id = v_actor_id;
  if v_actor_role not in ('boss', 'ol', 'developer') then
    raise exception 'only Boss / OL / Developer can bulk-mark';
  end if;
  -- Validate the month NUMBER too: to_date('2026-00-01') resolves to 2025-12,
  -- so a lax regex here would let this WRITE adjustments into a closed month.
  if p_month is null or p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'month must be YYYY-MM';
  end if;

  foreach v_uid in array coalesce(p_user_ids, '{}'::uuid[]) loop
    select p.role into v_target_role from public.profiles p where p.id = v_uid;
    if v_target_role is null then continue; end if;
    if not public._adjust_can_act(v_actor_id, v_actor_role, v_uid, v_target_role) then
      continue;
    end if;

    -- missed_dates_PAST (mig 256): weekdays only, holidays/leave/clock-ins
    -- excluded, and — crucially — EXCLUDES today, so a still-attendable day can
    -- never be stamped present. The actor is boss/ol/developer, hence privileged
    -- in the breakdown's gate, so this always returns a row.
    with inserted as (
      insert into public.attendance_adjustments (
        user_id, date, note, bulk, created_by, created_by_role
      )
      select v_uid, m.d::date, v_note, true, v_actor_id, v_actor_role
        from (
          select jsonb_array_elements_text(b.missed_dates_past) as d
            from public.attendance_month_breakdown(v_uid, p_month) b
        ) m
      on conflict (user_id, date) do nothing
      returning 1
    )
    select count(*)::int into v_user_added from inserted;

    if v_user_added > 0 then
      v_users := v_users + 1;
      v_total_added := v_total_added + v_user_added;
      perform public.emit_notification(
        v_uid,
        v_actor_id,
        'attendance',
        'attendance.manual_adjustment_bulk',
        coalesce(v_actor_name, 'Your manager') ||
          ' marked ' || v_user_added || ' day' ||
          case when v_user_added = 1 then '' else 's' end ||
          ' present in ' || p_month,
        case when v_note is not null then 'Note: ' || v_note
             else 'Your attendance was backfilled by your manager.' end,
        'attendance_adjustment_bulk',
        null,
        '/attendance'
      );
    end if;
  end loop;

  users_touched := v_users;
  days_added    := v_total_added;
  return next;
end;
$$;

revoke execute on function public.att_adjust_bulk_mark_missed(text, uuid[], text) from public, anon;
grant  execute on function public.att_adjust_bulk_mark_missed(text, uuid[], text) to authenticated, service_role;


-- ------------------------------------------------------------
-- E. FREEZE helper + wiring into the two payout RPCs.
--
-- _inc_freeze_attendance_items: rewrite every source='attendance' item in an
-- items array, pinning achievedValue to the row's live attendance % for its
-- month and freezing completed by the single threshold (pct/100 >= 0.9, target
-- 100). No-op (returns the array untouched) when there is no attendance item.
-- Reads the % via incentive_attendance_pct — the exact figure the read overlay
-- uses — so the frozen number equals what the employee last saw live.
-- ------------------------------------------------------------
create or replace function public._inc_freeze_attendance_items(
  p_items jsonb,
  p_month text,
  p_user  uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pct       numeric;
  v_completed boolean;
begin
  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or not exists (
          select 1 from jsonb_array_elements(p_items) e where e->>'source' = 'attendance'
        ) then
    return coalesce(p_items, '[]'::jsonb);
  end if;

  select b.pct into v_pct
    from public.incentive_attendance_pct(p_month, array[p_user]) b
   limit 1;
  v_pct := coalesce(v_pct, 0);
  -- Contract C2 (== incentivesApi.autoComplete): achieved/target >= 0.9, target
  -- pinned to 100 => pct >= 90. Written as the ratio to mirror the JS exactly.
  -- MONEY GATE: an attendance item may only COMPLETE once its month is CLOSED
  -- (Asia/Karachi) — the same isFinalMonth guard applyAttendanceAutofill applies.
  -- Without it, clearing a still-live month's payout (or rolling a live source
  -- month) would freeze a provisional running % as completed=true and PAID —
  -- e.g. 100% on the 1st of a Saturday-start month for someone who never clocked
  -- in (the single elapsed day is a covered weekend). Freeze the % either way,
  -- but only let it complete when final.
  v_completed := (p_month < to_char(now() at time zone 'Asia/Karachi', 'YYYY-MM'))
                 and (v_pct / 100.0) >= 0.9;

  return (
    select coalesce(jsonb_agg(
             case when e->>'source' = 'attendance'
                  then e || jsonb_build_object(
                         'achievedValue', v_pct,
                         'targetValue',   100,
                         'suffix',        coalesce(e->>'suffix', '%'),
                         'completed',     v_completed
                       )
                  else e
             end
             order by ord
           ), '[]'::jsonb)
      from jsonb_array_elements(p_items) with ordinality as t(e, ord)
  );
end;
$$;

revoke execute on function public._inc_freeze_attendance_items(jsonb, text, uuid) from public, anon;
grant  execute on function public._inc_freeze_attendance_items(jsonb, text, uuid) to authenticated, service_role;

-- inc_clear_payout — VERBATIM from mig 059 plus a freeze step on turn-on. The
-- freeze is a separate isolated UPDATE so the original payout UPDATE is byte-for-
-- byte unchanged; it re-reads v_row so the RPC returns the frozen items.
create or replace function public.inc_clear_payout(p_id uuid, p_cleared boolean)
returns public.incentives
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me  uuid := auth.uid();
  v_row public.incentives;
begin
  if not (public.is_boss(v_me) or exists (
    select 1 from public.profiles p where p.id = v_me and p.role in ('ol','developer') and p.is_active = true
  )) then raise exception 'only Boss/OL can clear payout'; end if;

  update public.incentives
     set payout_cleared = p_cleared
   where id = p_id
   returning * into v_row;
  if not found then raise exception 'incentives row not found'; end if;

  -- FREEZE (mig 256): snapshot attendance items' live % at pay time (decision 2).
  if p_cleared then
    update public.incentives
       set incentives = public._inc_freeze_attendance_items(incentives, month, user_id),
           bonuses    = public._inc_freeze_attendance_items(bonuses,    month, user_id)
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
grant execute on function public.inc_clear_payout(uuid, boolean) to authenticated;

-- inc_reset_and_roll — VERBATIM from mig 059 with the freeze folded into the
-- existing "mark source row payout_cleared" UPDATE. Rolls forward unchanged.
-- NOTE: based on the AUTHORITATIVE mig 189 definition (salary sourced from
-- employee_compensation with a fallback to the source month), NOT the older
-- mig 059 — the only additions here are the two freeze columns in Step 1.
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
    -- attendance items at the source-month figure (mig 256 / decision 2).
    if v_source.verified or p_force_clear then
      update public.incentives
         set payout_cleared    = true,
             payout_cleared_by = v_me,
             payout_cleared_at = now(),
             incentives        = public._inc_freeze_attendance_items(incentives, month, user_id),
             bonuses           = public._inc_freeze_attendance_items(bonuses,    month, user_id)
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
grant execute on function public.inc_reset_and_roll(text, text, boolean) to authenticated;


-- ------------------------------------------------------------
-- F. One-shot cleanup of stale persisted attendance %s on NON-paid rows.
-- _inc_reset_attendance_items nulls achievedValue + completed (keeps source,
-- pins target 100 + suffix). The backfill touches only non-paid rows that
-- actually carry an attendance item, so payout_cleared (frozen) rows and rows
-- with no attendance item are left untouched. Idempotent.
-- ------------------------------------------------------------
create or replace function public._inc_reset_attendance_items(p_items jsonb)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select coalesce(jsonb_agg(
           case when e->>'source' = 'attendance'
                then e || jsonb_build_object(
                       'achievedValue', null::numeric,
                       'completed',     false,
                       'targetValue',   100,
                       'suffix',        coalesce(e->>'suffix', '%')
                     )
                else e
           end
           order by ord
         ), '[]'::jsonb)
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) with ordinality as t(e, ord);
$$;

revoke execute on function public._inc_reset_attendance_items(jsonb) from public, anon;
grant  execute on function public._inc_reset_attendance_items(jsonb) to authenticated, service_role;

update public.incentives i
   set incentives = public._inc_reset_attendance_items(i.incentives),
       bonuses    = public._inc_reset_attendance_items(i.bonuses)
 where coalesce(i.payout_cleared, false) = false
   and (
     exists (select 1 from jsonb_array_elements(coalesce(i.incentives, '[]'::jsonb)) e where e->>'source' = 'attendance')
     or exists (select 1 from jsonb_array_elements(coalesce(i.bonuses,    '[]'::jsonb)) e where e->>'source' = 'attendance')
   );
