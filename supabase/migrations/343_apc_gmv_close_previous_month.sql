-- ============================================================
-- WurxOS v2 — Migration 343: the clock-in GMV gate closes the PREVIOUS month
-- before it starts asking about the new one.
--
-- ── WHAT APCs REPORTED ─────────────────────────────────────────────────────
-- On 1 September several APCs clocked in and were never asked for a GMV figure,
-- so August closed without its final day. Haseeb's last August submission
-- covered 1–30 Aug ($58,425.77); the real 1–31 figure was $62,183.42 and had to
-- be typed into Brand Analytics by hand.
--
-- Not a bug in the sense of something broken — the gate did exactly what mig
-- 311 told it to:
--     and (v_dom > 1)   -- on the 1st, range (1 -> yesterday) is empty -> skip
-- On the 1st, "month-to-date up to yesterday" would be 1 Sep -> 31 Aug, an
-- empty backwards range, so it correctly refused to ask a nonsense question.
-- But nobody ever asked about the last day of August either, and apc_submit_gmv
-- forces the write into the CURRENT month, so a submission on the 1st would
-- have landed in September regardless. Every month therefore closed one day
-- short, for every APC and every brand.
--
-- That is not always harmless. July's Penetrex figure cleared its target by
-- $1,959 — about one day's revenue. A brand finishing within a day's takings of
-- its goal could be recorded as missing it purely because the last day was
-- never collected, and GMV Max incentive lines pay on that figure.
--
-- ── THE FIX ────────────────────────────────────────────────────────────────
-- The gate now has two modes, and picks whichever is outstanding:
--
--   CLOSING  the previous month has no submission covering its final day
--            -> ask for the whole of last month (1st .. last day), write to
--               last month's key.
--   RUNNING  otherwise -> today's behaviour: this month, 1st .. yesterday,
--            still skipped on the 1st because that range is empty.
--
-- Closing takes precedence, so the first clock-in of a new month finishes the
-- old one and the next clock-in resumes the normal running total.
--
-- Deliberately NOT limited to the 1st. If the 1st is a weekend or the APC is on
-- leave, a day-of-month test would lose the close entirely; keying off "is it
-- actually captured yet" survives that. It is naturally bounded — once the
-- calendar moves on, "previous month" moves with it.
--
-- The target month is derived SERVER-SIDE in both functions. p_month_key stays
-- in the signature for client compatibility and stays ignored: a client must
-- not be able to nominate which month it is writing into.
--
-- Both functions are otherwise reproduced verbatim from mig 338, including its
-- `expires_at is null` filter — cover does not own the numbers.
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
  v_prev_end := (date_trunc('month', v_today)::date - 1);      -- last day of last month
  v_prev_key := to_char(v_prev_end, 'YYYY-MM');

  select coalesce(jsonb_agg(
           jsonb_build_object('id', b.id, 'name', b.brand_name, 'currency', b.currency)
           order by b.brand_name), '[]'::jsonb)
    into v_brands
    from public.brand_assignments ba
    join public.brands b on b.id = ba.brand_id and b.status = 'active'
   where ba.user_id = v_me
     and ba.expires_at is null;   -- PERMANENT only: cover does not own the numbers (mig 210)

  -- Has last month already been closed out to its final day by this APC?
  v_closing := not exists (
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
             -- on the 1st there is no running total to ask for, but there IS a
             -- previous month to close — so the day-of-month test only gates
             -- the running mode.
             and (v_closing or v_dom > 1)
             and (not v_submitted);

  return jsonb_build_object(
    'needs_entry',     v_needs,
    'role',            v_role,
    'today',           v_today,
    'month_key',       v_target,        -- the month being asked about
    'range_start',     v_range_s,
    'range_end',       v_range_e,
    'closing_month',   v_closing,       -- true => finishing last month
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
  v_shift    := public._shift_day(now());
  v_prev_end := (date_trunc('month', v_cal)::date - 1);
  v_prev_key := to_char(v_prev_end, 'YYYY-MM');

  -- Re-derive the target month exactly as apc_gmv_status does. Never trust
  -- p_month_key: a hand-made request must not be able to choose a month.
  v_closing := not exists (
    select 1 from public.apc_gmv_submissions s
     where s.apc_id     = v_me
       and s.month_key  = v_prev_key
       and s.range_end >= v_prev_end
  );
  v_month := case when v_closing then v_prev_key else to_char(v_cal, 'YYYY-MM') end;

  -- The audit range must lie inside the month actually being written.
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

    -- caller must be PERMANENTLY assigned to this ACTIVE brand (mig 338).
    if not exists (
      select 1 from public.brand_assignments ba
        join public.brands b on b.id = ba.brand_id and b.status = 'active'
       where ba.brand_id = v_brand and ba.user_id = v_me
         and ba.expires_at is null
    ) then
      raise exception 'not assigned to brand %', v_brand;
    end if;

    insert into public.brand_monthly_metrics (brand_id, month_key, gmv_achieved, updated_at, updated_by)
    values (v_brand, v_month, v_gmv, now(), v_me)          -- v_month is server-authoritative
    on conflict (brand_id, month_key) do update
      set gmv_achieved = excluded.gmv_achieved,
          updated_at   = now(),
          updated_by   = v_me;
  end loop;

  insert into public.apc_gmv_submissions (apc_id, entry_date, month_key, range_start, range_end, entries, created_at)
  values (v_me, v_shift, v_month, p_range_start, p_range_end, p_entries, now())   -- entry_date = SHIFT day
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
  v_open   int;
begin
  -- The guards inherited from migs 311/338 must survive the reproduction.
  if position('expires_at is null' in v_status) = 0
     or position('expires_at is null' in v_submit) = 0 then
    raise exception 'mig 343: lost the permanent-assignment filter from mig 338';
  end if;
  if position('only APCs submit GMV at clock-in' in v_submit) = 0
     or position('invalid GMV for brand' in v_submit) = 0
     or position('_shift_day' in v_submit) = 0 then
    raise exception 'mig 343: apc_submit_gmv lost one of its existing guards';
  end if;
  -- The new behaviour must actually be present on BOTH sides, or the gate would
  -- offer a month the writer then refuses.
  if position('v_closing' in v_status) = 0 or position('v_closing' in v_submit) = 0 then
    raise exception 'mig 343: the closing-month branch is missing from one side';
  end if;
  -- p_month_key must remain unused for the write month.
  if position('v_month := case when v_closing' in v_submit) = 0 then
    raise exception 'mig 343: the write month is no longer server-derived';
  end if;

  select count(*) into v_open
    from public.profiles p
   where p.role = 'apc' and p.is_active = true
     and exists (select 1 from public.brand_assignments ba
                  where ba.user_id = p.id and ba.expires_at is null)
     and not exists (
       select 1 from public.apc_gmv_submissions s
        where s.apc_id = p.id
          and s.month_key = to_char((date_trunc('month', (now() at time zone 'Asia/Karachi')::date)::date - 1), 'YYYY-MM')
          and s.range_end >= (date_trunc('month', (now() at time zone 'Asia/Karachi')::date)::date - 1));
  raise notice 'mig 343: % APC(s) will be asked to close last month at their next clock-in', v_open;
end;
$verify$;
