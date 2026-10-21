-- ============================================================
-- WurxOS v2 — Migration 422: at most FIVE workbook options per APC, per month.
--
-- The OL builds an APC's plan by ticking options from the brand workbook. The
-- cap is five per APC across ALL their brands combined — not five per brand —
-- and the picker enforces it on screen. This is the other half: the UI can be
-- bypassed (the row is writable by Boss/OL through PostgREST like any other),
-- and a limit that only exists in the browser is not a limit.
--
-- WHAT IS COUNTED. Only items carrying a `wbOption` marker AND a `brandId`:
-- the lines the workbook picker created. Attendance, punctuality, commission
-- tiers and anything the OL writes by hand are untouched, so this cannot stop
-- an ordinary plan being saved.
--
-- GRANDFATHERED, DELIBERATELY. A plan that already holds more than five — from
-- before this rule, or carried forward from such a month — is not retroactively
-- unsaveable. An UPDATE is refused only when it makes the count WORSE. So an OL
-- opening an old eight-option plan can still fix a typo and save; they just
-- cannot add a ninth, and any removal is always allowed. An INSERT has no prior
-- state to be lenient about, so it is held to the five.
--
-- Only APC and IPC rows are checked. A TL's or Ads Manager's plan is not built
-- from these options at all, and silently applying a creator-metric cap to a
-- different role's payroll would be a surprise nobody asked for.
--
-- Idempotent.
-- ============================================================

create or replace function public.incentives_count_workbook_options(p_row public.incentives)
returns int
language sql
immutable
as $$
  select count(*)::int
    from (
      select jsonb_array_elements(coalesce(p_row.incentives, '[]'::jsonb)) as it
      union all
      select jsonb_array_elements(coalesce(p_row.bonuses, '[]'::jsonb))
    ) x
   where x.it ? 'wbOption'
     and nullif(x.it ->> 'wbOption', '') is not null
     and nullif(x.it ->> 'brandId', '') is not null;
$$;

create or replace function public.incentives_guard_workbook_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role  text;
  v_new   int;
  v_old   int;
  v_limit constant int := 5;
begin
  select p.role into v_role from public.profiles p where p.id = new.user_id;
  if coalesce(v_role, '') not in ('apc', 'ipc') then
    return new;
  end if;

  v_new := public.incentives_count_workbook_options(new);
  if v_new <= v_limit then
    return new;
  end if;

  -- Over the cap. On an UPDATE, allow it through only if it does not add to an
  -- already-over count, so an old plan stays editable and shrinkable.
  if tg_op = 'UPDATE' then
    v_old := public.incentives_count_workbook_options(old);
    if v_new <= v_old then
      return new;
    end if;
    raise exception
      'This plan already has % workbook options; a plan may hold at most % across all brands. Remove one before adding another.',
      v_old, v_limit
      using errcode = '23514';
  end if;

  raise exception
    'An APC may have at most % workbook incentive options across all their brands combined (this plan has %).',
    v_limit, v_new
    using errcode = '23514';
end $$;

revoke execute on function public.incentives_guard_workbook_limit() from public, anon;

-- Runs after the existing incentives guards (Postgres fires BEFORE triggers in
-- name order, and incentives_guard* sort ahead of incentives_zz_*), so it sees
-- whatever those left behind rather than racing them.
drop trigger if exists incentives_zz_workbook_limit on public.incentives;
create trigger incentives_zz_workbook_limit
  before insert or update on public.incentives
  for each row execute function public.incentives_guard_workbook_limit();

-- ---- verification ----------------------------------------------------------
do $verify$
declare
  v_row public.incentives;
begin
  v_row.incentives := '[
    {"id":"a","brandId":"b1","wbOption":"video_authorized"},
    {"id":"b","brandId":"b2","wbOption":"creators_3plus"},
    {"id":"c","text":"Attendance"},
    {"id":"d","brandId":"b3"}
  ]'::jsonb;
  v_row.bonuses := '[{"id":"e","brandId":"b1","wbOption":"gmv_max"}]'::jsonb;

  if public.incentives_count_workbook_options(v_row) <> 3 then
    raise exception 'counter wrong: expected 3 workbook options, got %',
      public.incentives_count_workbook_options(v_row);
  end if;

  v_row.incentives := '[]'::jsonb;
  v_row.bonuses := '[]'::jsonb;
  if public.incentives_count_workbook_options(v_row) <> 0 then
    raise exception 'counter wrong on an empty plan';
  end if;

  raise notice '422 verified: workbook-option counter ignores manual and non-brand lines.';
end $verify$;
