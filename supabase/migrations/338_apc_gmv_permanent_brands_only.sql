-- ============================================================
-- WurxOS v2 — Migration 338: the clock-in GMV gate asks an APC only about
-- brands they PERMANENTLY hold — never about temporary cover.
--
-- ── WHAT HAPPENED ──────────────────────────────────────────────────────────
-- Biostime Shop US had two APCs: Faizan (permanent, since 2026-07-15) and
-- Farakh Farooq (TEMPORARY cover, expires 2026-09-07). apc_gmv_status listed
-- every row in brand_assignments with no regard for expires_at, so Farakh was
-- asked for Biostime's month-to-date GMV at his clock-in — a brand he does not
-- run and has no figure for.
--
-- The modal will not submit until every brand has a number in it
-- (ApcGmvGateModal `allFilled`), so "leave it blank" was not available to him.
-- He typed 0. apc_submit_gmv accepts 0 (it only rejects null/NaN/Inf/negative)
-- and overwrites wholesale, so Biostime's $13,917 became $0 at 2026-08-28
-- 11:19 UTC — 0.4s before his clock-in row was written.
--
-- That silently zeroed the GMV-Max incentive line for FOUR people who had
-- nothing to do with it: two TLs, an ads manager and Faizan himself. Nobody
-- was paid on it, and the figure has been restored to $15,474.56.
--
-- ── THE FIX ────────────────────────────────────────────────────────────────
-- `and ba.expires_at is null` in both places. Mig 210 defines exactly this:
-- a null expires_at is a permanent assignment, a non-null one is time-boxed
-- cover that a cron job deletes on expiry. Covering for someone means seeing
-- their brand and doing their tasks; it does not mean owning their numbers.
--
-- Applied in BOTH functions on purpose. Filtering only the status RPC would
-- hide the brand in the UI while leaving apc_submit_gmv willing to accept a
-- hand-made request for it — the gate would look fixed and the hole would
-- still be open.
--
-- Swapped brands are unaffected: a swap rewrites brand_assignments to a real
-- (null-expiry) row, so the new APC is genuinely assigned and still gets asked.
-- Only time-boxed cover is excluded.
--
-- Live at the time of writing this touches two people — Farakh Farooq on
-- Biostime (until 2026-09-07) and Azan Khan on JoyMode (until 2026-09-06).
-- JoyMode had not been wiped yet; it would have been on Azan's next clock-in.
--
-- Both functions are otherwise reproduced VERBATIM from migs 311 / 312.
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
  v_brands    jsonb;
  v_submitted boolean;
  v_needs     boolean;
begin
  if v_me is null then return jsonb_build_object('needs_entry', false); end if;
  select role into v_role from public.profiles where id = v_me and is_active = true;
  v_today := (now() at time zone 'Asia/Karachi')::date;
  v_dom   := extract(day from v_today)::int;
  v_month := to_char(v_today, 'YYYY-MM');

  select coalesce(jsonb_agg(
           jsonb_build_object('id', b.id, 'name', b.brand_name, 'currency', b.currency)
           order by b.brand_name), '[]'::jsonb)
    into v_brands
    from public.brand_assignments ba
    join public.brands b on b.id = ba.brand_id and b.status = 'active'
   where ba.user_id = v_me
     and ba.expires_at is null;   -- PERMANENT only: cover does not own the numbers (mig 210)

  select exists(select 1 from public.apc_gmv_submissions s
                 where s.apc_id = v_me and s.entry_date = v_today)
    into v_submitted;

  v_needs := (v_role = 'apc')
             and (jsonb_array_length(v_brands) > 0)
             and (v_dom > 1)          -- on the 1st, range (1 -> yesterday) is empty -> skip
             and (not v_submitted);

  return jsonb_build_object(
    'needs_entry',     v_needs,
    'role',            v_role,
    'today',           v_today,
    'month_key',       v_month,
    'range_start',     date_trunc('month', v_today)::date,
    'range_end',       (v_today - 1),
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
  v_me    uuid := auth.uid();
  v_role  text;
  v_cal   date;
  v_shift date;
  v_month text;
  v_entry jsonb;
  v_brand uuid;
  v_gmv   numeric;
begin
  if v_me is null then raise exception 'not authenticated'; end if;
  select role into v_role from public.profiles where id = v_me and is_active = true;
  if v_role is null then raise exception 'inactive user'; end if;
  if v_role <> 'apc' then raise exception 'only APCs submit GMV at clock-in'; end if;
  if p_entries is null or jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries) = 0 then
    raise exception 'no GMV entries';
  end if;

  v_cal   := (now() at time zone 'Asia/Karachi')::date;
  v_shift := public._shift_day(now());
  v_month := to_char(v_cal, 'YYYY-MM');   -- authoritative: always the current PKT month

  -- The audit range must lie inside the current month (blocks an edited range
  -- from crossing into another month; the achieved value is month-to-date).
  if p_range_start is null or p_range_end is null
     or to_char(p_range_start, 'YYYY-MM') <> v_month
     or to_char(p_range_end,   'YYYY-MM') <> v_month
     or p_range_start > p_range_end then
    raise exception 'range must be within the current month';
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

    -- caller must be PERMANENTLY assigned to this ACTIVE brand. The expiry
    -- check is here as well as in apc_gmv_status: filtering only the UI would
    -- leave a hand-made request able to overwrite a brand the caller is merely
    -- covering.
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
  v_temp   int;
  v_perm   int;
begin
  if position('expires_at is null' in v_status) = 0 then
    raise exception 'mig 338: apc_gmv_status still offers temporary cover brands';
  end if;
  if position('expires_at is null' in v_submit) = 0 then
    raise exception 'mig 338: apc_submit_gmv still accepts temporary cover brands';
  end if;
  -- the guards that were already there must survive the reproduction
  if position('only APCs submit GMV at clock-in' in v_submit) = 0
     or position('range must be within the current month' in v_submit) = 0
     or position('invalid GMV for brand' in v_submit) = 0
     or position('_shift_day' in v_submit) = 0 then
    raise exception 'mig 338: apc_submit_gmv lost one of its existing guards';
  end if;

  select count(*) filter (where ba.expires_at is not null),
         count(*) filter (where ba.expires_at is null)
    into v_temp, v_perm
    from public.brand_assignments ba
    join public.profiles p on p.id = ba.user_id and p.role = 'apc';
  raise notice 'mig 338: APC assignments — % permanent (still asked), % temporary (now skipped)', v_perm, v_temp;
end;
$verify$;
