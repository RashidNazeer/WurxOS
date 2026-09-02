-- ============================================================
-- WurxOS v2 — Migration 344: the previous-month close-out is offered on the
-- 1st ONLY. After that the gate moves on to the new month.
--
-- ── WHY THIS CHANGES A MIGRATION FROM AN HOUR AGO ──────────────────────────
-- Mig 343 made the gate close the previous month whenever that month had no
-- submission covering its final day, deliberately NOT limited to the 1st so
-- that a weekend or a day of leave could not lose the close.
--
-- That was the wrong trade. Two consequences the Boss caught immediately:
--
--   1. It BLOCKS the new month. The close takes precedence, so on 3 September
--      an APC is asked about August and September 1-2 goes uncollected for
--      another day. Chasing a finished month delays the live one.
--
--   2. It reopens figures that have already been settled by hand. August's
--      Penetrex and Inno Supps totals were corrected manually
--      ($62,183.42 and $100,233.40); an APC typing a remembered 1-30 number at
--      their next clock-in would silently undo that.
--
-- And the thing it was protecting is worth less than it looked. Measured on
-- 2026-09-02: of the 13 August brands below the 90% incentive line, the closest
-- (Obagi, 83.1%) needs 2.6 more days of revenue to cross it. **No brand could
-- be flipped by a single missing day**, so collecting August now moves no money
-- at all — it only creates a chance to overwrite good figures with worse ones.
--
-- ── THE RULE NOW ───────────────────────────────────────────────────────────
--   day 1 of the month  -> close out the previous month (full 1st .. last day)
--   day 2 onwards       -> this month, 1st .. yesterday, as it always was
--
-- So on 3 September an APC is asked for 1-2 September, which is what should
-- have happened all along. The reason the 1 September prompt never appeared is
-- mig 311's `v_dom > 1` skip, which mig 343 fixed; from 1 October this fires on
-- the day it should.
--
-- ── THE RISK THAT REMAINS, AND WHY IT IS ACCEPTABLE ────────────────────────
-- If the 1st falls on a weekend, or an APC is on leave that day, that month's
-- final day is not collected from them. It is NOT lost: an OL or Boss can set
-- any month's achieved figure in Brand Analytics, and since mig 341/342 the
-- brand's own TL can see it there too, so the gap is visible to three roles
-- rather than silently absorbed. A one-day shortfall that cannot cross a 90%
-- threshold does not justify holding the new month hostage.
--
-- Both functions are otherwise reproduced verbatim from mig 343.
-- Idempotent.
-- ============================================================

-- ── 1. What the gate ASKS for ───────────────────────────────────────────────
create or replace function public.apc_gmv_status()
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_me        uuid := auth.uid();
  v_role      text;
  v_today     date;
  v_dom       int;
  v_month     text;
  v_prev_end  date;
  v_prev_key  text;
  v_closing   boolean := false;
  v_range_s   date;
  v_range_e   date;
  v_target    text;
  v_brands    jsonb;
  v_submitted boolean;
  v_needs     boolean;
begin
  if v_me is null then return jsonb_build_object('needs_entry', false); end if;
  select role into v_role from public.profiles where id = v_me and is_active = true;
  v_today    := (now() at time zone 'Asia/Karachi')::date;
  v_dom      := extract(day from v_today)::int;
  v_month    := to_char(v_today, 'YYYY-MM');
  v_prev_end := (date_trunc('month', v_today)::date - 1);
  v_prev_key := to_char(v_prev_end, 'YYYY-MM');

  select coalesce(jsonb_agg(
           jsonb_build_object('id', b.id, 'name', b.brand_name, 'currency', b.currency)
           order by b.brand_name), '[]'::jsonb)
    into v_brands
    from public.brand_assignments ba
    join public.brands b on b.id = ba.brand_id and b.status = 'active'
   where ba.user_id = v_me
     and ba.expires_at is null;   -- PERMANENT only: cover does not own the numbers (mig 210)

  -- ONLY on the 1st, and only if last month is not already closed to its final
  -- day. From the 2nd the finished month is left alone — see the header.
  v_closing := (v_dom = 1) and not exists (
    select 1 from public.apc_gmv_submissions s
     where s.apc_id     = v_me
       and s.month_key  = v_prev_key
       and s.range_end >= v_prev_end
  );

  if v_closing then
    v_target  := v_prev_key;
    v_range_s := date_trunc('month', v_prev_end)::date;
    v_range_e := v_prev_end;
  else
    v_target  := v_month;
    v_range_s := date_trunc('month', v_today)::date;
    v_range_e := v_today - 1;
  end if;

  select exists(select 1 from public.apc_gmv_submissions s
                 where s.apc_id = v_me and s.entry_date = v_today)
    into v_submitted;

  v_needs := (v_role = 'apc')
             and (jsonb_array_length(v_brands) > 0)
             -- on the 1st the running range is empty, so the only thing worth
             -- asking for that day is the close-out.
             and (v_closing or v_dom > 1)
             and (not v_submitted);

  return jsonb_build_object(
    'needs_entry',     v_needs,
    'role',            v_role,
    'today',           v_today,
    'month_key',       v_target,
    'range_start',     v_range_s,
    'range_end',       v_range_e,
    'closing_month',   v_closing,
    'submitted_today', v_submitted,
    'brands',          v_brands
  );
end;
$$;

-- ── 2. What the gate ACCEPTS ────────────────────────────────────────────────
create or replace function public.apc_submit_gmv(
  p_month_key   text,   -- accepted for client compat; the write month is server-derived
  p_range_start date,
  p_range_end   date,
  p_entries     jsonb
) returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_me       uuid := auth.uid();
  v_role     text;
  v_cal      date;
  v_dom      int;
  v_shift    date;
  v_month    text;
  v_prev_end date;
  v_prev_key text;
  v_closing  boolean;
  v_entry    jsonb;
  v_brand    uuid;
  v_gmv      numeric;
begin
  if v_me is null then raise exception 'not authenticated'; end if;
  select role into v_role from public.profiles where id = v_me and is_active = true;
  if v_role is null then raise exception 'inactive user'; end if;
  if v_role <> 'apc' then raise exception 'only APCs submit GMV at clock-in'; end if;
  if p_entries is null or jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries) = 0 then
    raise exception 'no GMV entries';
  end if;

  v_cal      := (now() at time zone 'Asia/Karachi')::date;
  v_dom      := extract(day from v_cal)::int;
  v_shift    := public._shift_day(now());
  v_prev_end := (date_trunc('month', v_cal)::date - 1);
  v_prev_key := to_char(v_prev_end, 'YYYY-MM');

  -- Re-derived server-side, identically to apc_gmv_status. p_month_key is never
  -- trusted: a hand-made request must not be able to choose a month, and in
  -- particular must not be able to reopen a finished one after the 1st.
  v_closing := (v_dom = 1) and not exists (
    select 1 from public.apc_gmv_submissions s
     where s.apc_id     = v_me
       and s.month_key  = v_prev_key
       and s.range_end >= v_prev_end
  );
  v_month := case when v_closing then v_prev_key else to_char(v_cal, 'YYYY-MM') end;

  if p_range_start is null or p_range_end is null
     or to_char(p_range_start, 'YYYY-MM') <> v_month
     or to_char(p_range_end,   'YYYY-MM') <> v_month
     or p_range_start > p_range_end then
    raise exception 'range must be within %', v_month;
  end if;

  for v_entry in select value from jsonb_array_elements(p_entries)
  loop
    v_brand := (v_entry->>'brand_id')::uuid;
    v_gmv   := (v_entry->>'gmv')::numeric;
    if v_gmv is null
       or v_gmv = 'NaN'::numeric
       or v_gmv = 'Infinity'::numeric
       or v_gmv = '-Infinity'::numeric
       or v_gmv < 0
       or v_gmv > 1e15 then
      raise exception 'invalid GMV for brand %', v_brand;
    end if;

    if not exists (
      select 1 from public.brand_assignments ba
        join public.brands b on b.id = ba.brand_id and b.status = 'active'
       where ba.brand_id = v_brand and ba.user_id = v_me
         and ba.expires_at is null
    ) then
      raise exception 'not assigned to brand %', v_brand;
    end if;

    insert into public.brand_monthly_metrics (brand_id, month_key, gmv_achieved, updated_at, updated_by)
    values (v_brand, v_month, v_gmv, now(), v_me)
    on conflict (brand_id, month_key) do update
      set gmv_achieved = excluded.gmv_achieved,
          updated_at   = now(),
          updated_by   = v_me;
  end loop;

  insert into public.apc_gmv_submissions (apc_id, entry_date, month_key, range_start, range_end, entries, created_at)
  values (v_me, v_shift, v_month, p_range_start, p_range_end, p_entries, now())
  on conflict (apc_id, entry_date) do update
    set month_key   = excluded.month_key,
        range_start = excluded.range_start,
        range_end   = excluded.range_end,
        entries     = excluded.entries,
        created_at  = now();
end;
$$;

-- ── 3. Self-verification ────────────────────────────────────────────────────
do $verify$
declare
  v_status text := pg_get_functiondef('public.apc_gmv_status()'::regprocedure);
  v_submit text := pg_get_functiondef('public.apc_submit_gmv(text, date, date, jsonb)'::regprocedure);
  v_dom    int  := extract(day from (now() at time zone 'Asia/Karachi')::date)::int;
begin
  -- The day-1 restriction must be on BOTH sides, or the gate would offer a
  -- month the writer then refuses (or worse, accept one it should not).
  if position('(v_dom = 1) and not exists' in v_status) = 0
     or position('(v_dom = 1) and not exists' in v_submit) = 0 then
    raise exception 'mig 344: the close-out is not restricted to the 1st on both sides';
  end if;
  -- Guards inherited from migs 311/338/343 must survive the reproduction.
  if position('expires_at is null' in v_status) = 0
     or position('expires_at is null' in v_submit) = 0 then
    raise exception 'mig 344: lost the permanent-assignment filter from mig 338';
  end if;
  if position('only APCs submit GMV at clock-in' in v_submit) = 0
     or position('invalid GMV for brand' in v_submit) = 0
     or position('_shift_day' in v_submit) = 0 then
    raise exception 'mig 344: apc_submit_gmv lost one of its existing guards';
  end if;

  if v_dom = 1 then
    raise notice 'mig 344: today IS the 1st — APCs will be asked to close last month';
  else
    raise notice 'mig 344: today is day % — no close-out; APCs are asked for this month 1..%',
      v_dom, v_dom - 1;
  end if;
end;
$verify$;
