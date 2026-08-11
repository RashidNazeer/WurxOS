-- ============================================================
-- 312 — Harden the APC GMV-on-clock-in RPCs (review fixes for mig 311)
--
-- 1. DEDUP by SHIFT DAY, not calendar day. att_clock_in (mig 154) keys the
--    attendance row on _shift_day(now()) (rolls 3pm PKT), so a night-shift
--    re-clock-in after midnight is the SAME shift day. Keying the gate on the
--    calendar day re-fired it after midnight, overwriting gmv_achieved with a
--    fresh value + logging a phantom row while att_clock_in then refused the
--    re-clock-in. entry_date now holds the SHIFT day so the gate matches.
-- 2. Bind the written month SERVER-SIDE (current PKT month). The old RPC wrote
--    the caller-supplied p_month_key verbatim -> an APC could overwrite any
--    month's gmv_achieved (a boss/OL-only write) by calling the RPC directly.
--    p_month_key is now ignored for the write; the audit range must lie inside
--    the current month.
-- 3. Reject non-finite / absurd GMV (NaN, +/-Infinity, >1e15) which slipped the
--    `< 0` guard.
--
-- Range/month/day-of-month stay CALENDAR-PKT (the APC reports GMV for calendar
-- days 1 -> yesterday). Only the once-per-day dedup key is the shift day.
-- ============================================================

create or replace function public.apc_gmv_status()
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_me        uuid := auth.uid();
  v_role      text;
  v_cal       date;    -- calendar PKT date: drives range/month/day-of-month
  v_shift     date;    -- shift day (rolls 3pm PKT): the once-per-day dedup key
  v_dom       int;
  v_month     text;
  v_brands    jsonb;
  v_submitted boolean;
  v_needs     boolean;
begin
  if v_me is null then return jsonb_build_object('needs_entry', false); end if;
  select role into v_role from public.profiles where id = v_me and is_active = true;
  v_cal   := (now() at time zone 'Asia/Karachi')::date;
  v_shift := public._shift_day(now());
  v_dom   := extract(day from v_cal)::int;
  v_month := to_char(v_cal, 'YYYY-MM');

  select coalesce(jsonb_agg(
           jsonb_build_object('id', b.id, 'name', b.brand_name, 'currency', b.currency)
           order by b.brand_name), '[]'::jsonb)
    into v_brands
    from public.brand_assignments ba
    join public.brands b on b.id = ba.brand_id and b.status = 'active'
   where ba.user_id = v_me;

  select exists(select 1 from public.apc_gmv_submissions s
                 where s.apc_id = v_me and s.entry_date = v_shift)
    into v_submitted;

  v_needs := (v_role = 'apc')
             and (jsonb_array_length(v_brands) > 0)
             and (v_dom > 1)
             and (not v_submitted);

  return jsonb_build_object(
    'needs_entry',     v_needs,
    'role',            v_role,
    'today',           v_cal,
    'month_key',       v_month,
    'range_start',     date_trunc('month', v_cal)::date,
    'range_end',       (v_cal - 1),
    'submitted_today', v_submitted,
    'brands',          v_brands
  );
end;
$$;
revoke all on function public.apc_gmv_status() from public, anon;
grant execute on function public.apc_gmv_status() to authenticated;

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

    -- caller must be assigned to this ACTIVE brand
    if not exists (
      select 1 from public.brand_assignments ba
        join public.brands b on b.id = ba.brand_id and b.status = 'active'
       where ba.brand_id = v_brand and ba.user_id = v_me
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
revoke all on function public.apc_submit_gmv(text, date, date, jsonb) from public, anon;
grant execute on function public.apc_submit_gmv(text, date, date, jsonb) to authenticated;
