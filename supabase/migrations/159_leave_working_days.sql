-- ============================================================
-- WurxOS v2 — Migration 159: count weekdays only for leave totals
--
-- User report: an APC requests Friday + Monday WFH, and the app
-- shows 4 days because it counts the Sat + Sun in between. The
-- weekend days aren't actually time off — they were already off.
-- Charging the quota for them is wrong and inflates the unpaid_days
-- gate (forcing Boss approval for what should be a 2-day request).
--
-- Standard WurxCrew week is Mon-Fri. Sat (6) + Sun (0) are weekends
-- and never count against any leave quota.
--
-- This migration:
--   1. _leave_working_days(start, end) — counts Mon-Fri days in the
--      inclusive range. Returns numeric so we can stay compatible
--      with half_leave 0.5d.
--   2. Rewrites consumed_leaves_month / consumed_leaves to use it.
--   3. Rewrites leave_compute_paid_days BEFORE INSERT trigger to
--      use it for both the 'other' bucket and the paid/unpaid split.
--   4. Re-stamps existing rows: recompute paid_days / unpaid_days
--      for every PENDING request so any in-flight request that was
--      already inflated (e.g., the Fri+Mon case the user reported)
--      gets corrected. Approved/rejected rows are left alone — that
--      history is sealed.
--
-- Idempotent.
-- ============================================================

-- 1. Helper
create or replace function public._leave_working_days(p_start date, p_end date)
returns numeric
language sql
immutable
set search_path = public
as $$
  -- Count days where extract(isodow) is 1..5 (Mon-Fri).
  -- isodow: 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat, 7=Sun.
  select coalesce(count(*), 0)::numeric
  from generate_series(p_start, p_end, interval '1 day') d
  where extract(isodow from d) between 1 and 5;
$$;
grant execute on function public._leave_working_days(date, date) to authenticated;

-- 2a. consumed_leaves_month
create or replace function public.consumed_leaves_month(p_user uuid, p_year int, p_month int)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  with rows_in_month as (
    select type,
           public._leave_working_days(start_date, end_date) as raw_days
      from public.leave_requests
     where requester_id = p_user
       and status = 'approved'
       and extract(year  from start_date) = p_year
       and extract(month from start_date) = p_month
  ),
  tallied as (
    select case when type = 'half_leave' then 'medical' else type end as bucket,
           case when type = 'half_leave' then 0.5 else raw_days end as days
      from rows_in_month
  )
  select jsonb_build_object(
    'wfh',       coalesce((select sum(days)::numeric from tallied where bucket = 'wfh'), 0),
    'medical',   coalesce((select sum(days)::numeric from tallied where bucket = 'medical'), 0),
    'emergency', coalesce((select sum(days)::numeric from tallied where bucket = 'emergency'), 0)
  );
$$;

-- 2b. consumed_leaves (yearly)
create or replace function public.consumed_leaves(p_user uuid, p_year int)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  with rows_in_year as (
    select type,
           public._leave_working_days(start_date, end_date) as raw_days
      from public.leave_requests
     where requester_id = p_user
       and status = 'approved'
       and extract(year from start_date) = p_year
  ),
  tallied as (
    select case when type = 'half_leave' then 'medical' else type end as bucket,
           case when type = 'half_leave' then 0.5 else raw_days end as days
      from rows_in_year
  )
  select jsonb_build_object(
    'wfh',       coalesce((select sum(days)::numeric from tallied where bucket = 'wfh'),       0),
    'medical',   coalesce((select sum(days)::numeric from tallied where bucket = 'medical'),   0),
    'emergency', coalesce((select sum(days)::numeric from tallied where bucket = 'emergency'), 0)
  );
$$;

-- 3. BEFORE INSERT trigger function
create or replace function public.leave_compute_paid_days()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quota      jsonb;
  v_consumed   jsonb;
  v_bucket     text;
  v_quota_d    numeric;
  v_used_d     numeric;
  v_remaining  numeric;
  v_requested  numeric;
  v_month      int;
  v_year       int;
begin
  -- 'other' bucket: always unpaid, no quota touched.
  if new.type = 'other' then
    new.paid_days   := 0;
    new.unpaid_days := public._leave_working_days(new.start_date, new.end_date);
    return new;
  end if;

  if new.type = 'half_leave' then
    v_requested := 0.5;
  else
    v_requested := public._leave_working_days(new.start_date, new.end_date);
  end if;

  v_bucket := case new.type
    when 'half_leave' then 'medical'
    when 'medical'    then 'medical'
    when 'emergency'  then 'emergency'
    when 'wfh'        then 'wfh'
    else null
  end;

  select coalesce(leave_quota, '{}'::jsonb) into v_quota
    from public.profiles where id = new.requester_id;
  v_quota_d := coalesce((v_quota->>v_bucket)::numeric, 0);

  v_year  := extract(year  from new.start_date)::int;
  v_month := extract(month from new.start_date)::int;
  v_consumed := public.consumed_leaves_month(new.requester_id, v_year, v_month);
  v_used_d := coalesce((v_consumed->>v_bucket)::numeric, 0);

  v_remaining := greatest(0, v_quota_d - v_used_d);

  if v_requested <= v_remaining then
    new.paid_days   := v_requested;
    new.unpaid_days := 0;
  else
    new.paid_days   := v_remaining;
    new.unpaid_days := v_requested - v_remaining;
  end if;

  return new;
end;
$$;

-- 4. Backfill: recompute paid_days / unpaid_days for any PENDING
--    request whose current numbers were inflated by weekend days.
--    Decided rows (approved/rejected/cancelled) are sealed history.
do $$
declare
  r record;
  v_corrected int := 0;
  v_quota     jsonb;
  v_consumed  jsonb;
  v_bucket    text;
  v_quota_d   numeric;
  v_used_d    numeric;
  v_remaining numeric;
  v_requested numeric;
  v_paid      numeric;
  v_unpaid    numeric;
begin
  for r in
    select * from public.leave_requests
     where status = 'pending'
  loop
    if r.type = 'other' then
      v_paid := 0;
      v_unpaid := public._leave_working_days(r.start_date, r.end_date);
    else
      if r.type = 'half_leave' then
        v_requested := 0.5;
      else
        v_requested := public._leave_working_days(r.start_date, r.end_date);
      end if;
      v_bucket := case r.type
        when 'half_leave' then 'medical'
        when 'medical'    then 'medical'
        when 'emergency'  then 'emergency'
        when 'wfh'        then 'wfh'
        else null
      end;
      select coalesce(leave_quota, '{}'::jsonb) into v_quota
        from public.profiles where id = r.requester_id;
      v_quota_d := coalesce((v_quota->>v_bucket)::numeric, 0);
      v_consumed := public.consumed_leaves_month(
        r.requester_id,
        extract(year  from r.start_date)::int,
        extract(month from r.start_date)::int
      );
      -- Exclude THIS row from the used-tally for self-recompute.
      -- consumed_leaves_month only counts 'approved' so it already
      -- excludes pending — no adjustment needed.
      v_used_d := coalesce((v_consumed->>v_bucket)::numeric, 0);
      v_remaining := greatest(0, v_quota_d - v_used_d);
      if v_requested <= v_remaining then
        v_paid := v_requested;
        v_unpaid := 0;
      else
        v_paid := v_remaining;
        v_unpaid := v_requested - v_remaining;
      end if;
    end if;
    if r.paid_days is distinct from v_paid or r.unpaid_days is distinct from v_unpaid then
      update public.leave_requests
         set paid_days = v_paid,
             unpaid_days = v_unpaid
       where id = r.id;
      v_corrected := v_corrected + 1;
    end if;
  end loop;
  raise notice '[mig 159] recomputed paid/unpaid_days for % pending leave request(s)', v_corrected;
end;
$$;
