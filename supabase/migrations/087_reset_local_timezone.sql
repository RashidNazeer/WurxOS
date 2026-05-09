-- ============================================================
-- WurxOS v2 — Migration 087: compute_next_reset honors user timezone
--
-- Bug: the previous compute_next_reset() built reset times by adding
-- the user's hh:mm to date_trunc('day', now())::timestamp, then
-- pinned the result to UTC. That treated "12:59" as 12:59 UTC for
-- everyone, regardless of the user's profiles.timezone. A user in
-- Asia/Karachi who set "12:59" expecting their local lunchtime got
-- their tasks reset at 17:59 PKT (12:59 UTC).
--
-- Fix: convert now() into the user's local wall clock first
-- (`now() at time zone profiles.timezone`), build the candidate
-- timestamp in that local frame, then convert back to UTC for
-- storage. profiles.timezone defaults to 'UTC' so users without a
-- set timezone behave exactly as before.
--
-- After the function is replaced, we recompute next_reset_at for
-- every existing recurring task so they pick up the corrected math
-- without the user having to touch them.
-- ============================================================

create or replace function public.compute_next_reset(uid uuid, cat text)
returns timestamptz
language plpgsql
stable
set search_path = public
as $$
declare
  v_schedule jsonb;
  v_tz       text;
  v_now_local timestamp;     -- naive timestamp = current wall clock in user's tz
  v_today    date;
  v_time     text;
  v_hh       int;
  v_mm       int;
  v_dow      int;
  v_dom      int;
  v_candidate timestamp;     -- naive timestamp in user's local frame
  v_days_ahead int;
begin
  if cat = 'general' then return null; end if;

  select reset_schedule, coalesce(timezone, 'UTC')
    into v_schedule, v_tz
    from public.profiles where id = uid;

  if v_schedule is null then
    v_schedule := '{"daily":{"time":"00:00"},"weekly":{"dayOfWeek":1,"time":"00:00"},"monthly":{"dayOfMonth":1,"time":"00:00"}}'::jsonb;
  end if;

  -- Bad/unknown timezone strings (rare) → fall back to UTC so the
  -- function never errors out.
  begin
    v_now_local := (now() at time zone v_tz)::timestamp;
  exception when others then
    v_tz := 'UTC';
    v_now_local := (now() at time zone 'UTC')::timestamp;
  end;
  v_today := v_now_local::date;

  if cat = 'daily' then
    v_time := coalesce(v_schedule->'daily'->>'time', '00:00');
    v_hh := split_part(v_time, ':', 1)::int;
    v_mm := split_part(v_time, ':', 2)::int;
    v_candidate := v_today::timestamp + make_interval(hours => v_hh, mins => v_mm);
    if v_candidate <= v_now_local then
      v_candidate := v_candidate + interval '1 day';
    end if;
    return v_candidate at time zone v_tz;
  end if;

  if cat = 'weekly' then
    v_time := coalesce(v_schedule->'weekly'->>'time', '00:00');
    v_dow  := coalesce((v_schedule->'weekly'->>'dayOfWeek')::int, 1);
    v_hh := split_part(v_time, ':', 1)::int;
    v_mm := split_part(v_time, ':', 2)::int;
    v_days_ahead := (v_dow - extract(dow from v_now_local)::int + 7) % 7;
    v_candidate := v_today::timestamp
                   + make_interval(days => v_days_ahead, hours => v_hh, mins => v_mm);
    if v_candidate <= v_now_local then
      v_candidate := v_candidate + interval '7 days';
    end if;
    return v_candidate at time zone v_tz;
  end if;

  if cat = 'monthly' then
    v_time := coalesce(v_schedule->'monthly'->>'time', '00:00');
    v_dom  := coalesce((v_schedule->'monthly'->>'dayOfMonth')::int, 1);
    v_hh := split_part(v_time, ':', 1)::int;
    v_mm := split_part(v_time, ':', 2)::int;
    v_candidate := date_trunc('month', v_now_local)::timestamp
                   + make_interval(days => v_dom - 1, hours => v_hh, mins => v_mm);
    if v_candidate <= v_now_local then
      v_candidate := (date_trunc('month', v_now_local) + interval '1 month')::timestamp
                     + make_interval(days => v_dom - 1, hours => v_hh, mins => v_mm);
    end if;
    return v_candidate at time zone v_tz;
  end if;

  return null;
end;
$$;

-- --------------------------------------------------------------
-- Recompute next_reset_at for every existing recurring task so
-- they immediately follow the corrected timezone-aware math.
-- The reset cron will then pick up tasks whose new (correct) reset
-- time has already passed and reset them on the next minute tick.
-- --------------------------------------------------------------
update public.tasks
   set next_reset_at = public.compute_next_reset(assignee_id, category),
       updated_at    = now()
 where category in ('daily','weekly','monthly');
