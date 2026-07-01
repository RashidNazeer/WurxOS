-- ============================================================
-- WurxOS v2 — Migration 220: give export_all_data() a longer statement timeout.
--
-- The `authenticated` role runs with statement_timeout = 8s. A WARM export
-- takes ~2.7s (fine), but the FIRST export after the project has been idle
-- reads ~16MB across 69 tables off cold disk and can briefly exceed 8s —
-- Postgres then cancels it ("canceling statement due to statement timeout"),
-- and only the (now-warm) retry succeeds. That forced a manual "Try again".
--
-- Fix: raise the timeout for THIS FUNCTION ONLY via `set local` in the body.
-- It applies solely while export_all_data() runs and reverts automatically on
-- return — the role's 8s default and every other query are untouched. 60s is
-- generous headroom over the 2.7s warm time (absorbs any cold-start spike)
-- while staying well under the db-level 2min ceiling, so a genuinely stuck
-- export still can't hang indefinitely.
--
-- Body is otherwise IDENTICAL to migration 219 (only the SET LOCAL line and
-- this note are added). Recreated in place with the same signature.
-- ============================================================

create or replace function public.export_all_data()
returns jsonb
language plpgsql
security definer
set search_path = public
-- Function-scoped statement timeout: overrides the role's 8s only for this
-- function. Reverts automatically when the function returns.
set statement_timeout = '60s'
as $$
declare
  v_actor        uuid := auth.uid();
  v_caller_role  text;
  v_caller_active boolean;
  v_skip         text[] := array[
    'audit_log', 'app_events', 'euka_api_cache',
    'push_subscriptions', 'app_config'
  ];
  v_table        text;
  v_rows         jsonb;
  v_count        bigint;
  v_data         jsonb := '{}'::jsonb;
  v_counts       jsonb := '{}'::jsonb;
  v_tables       text[] := array[]::text[];
  v_total        bigint := 0;
begin
  if v_actor is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select role, is_active into v_caller_role, v_caller_active
    from public.profiles where id = v_actor;

  if v_caller_role is distinct from 'boss' or v_caller_active is not true then
    raise exception 'Forbidden — Boss only' using errcode = '42501';
  end if;

  -- Every base table in the public schema, minus the skip-list, minus
  -- Postgres internals. Discovered at runtime so future tables are always
  -- included without editing this function.
  for v_table in
    select table_name
      from information_schema.tables
     where table_schema = 'public'
       and table_type = 'BASE TABLE'
       and table_name <> all (v_skip)
     order by table_name
  loop
    -- Dump the whole table as a JSON array of row objects. jsonb_agg
    -- preserves every column and type; empty tables become [].
    execute format(
      'select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb), count(*) from public.%I t',
      v_table
    ) into v_rows, v_count;

    v_data   := v_data   || jsonb_build_object(v_table, v_rows);
    v_counts := v_counts || jsonb_build_object(v_table, v_count);
    v_tables := v_tables || v_table;
    v_total  := v_total + v_count;
  end loop;

  -- Record when the backup was taken (atomic with the export itself, so the
  -- reminder timestamp can never claim a backup that didn't happen).
  insert into public.app_config (key, value)
  values ('last_backup_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
  on conflict (key) do update set value = excluded.value;

  return jsonb_build_object(
    'meta', jsonb_build_object(
      'app', 'WurxOS',
      'kind', 'full-data-backup',
      'version', 1,
      'generated_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'generated_by', v_actor,
      'tables', v_tables,
      'excluded', v_skip,
      'row_counts', v_counts,
      'total_rows', v_total
    ),
    'data', v_data
  );
end;
$$;

revoke all on function public.export_all_data() from public;
grant execute on function public.export_all_data() to authenticated;

comment on function public.export_all_data() is
  'Boss-only. Returns a complete { meta, data } JSON snapshot of every business table in public (discovered at runtime; skips logs/cache/config-with-secrets), bypassing RLS so the backup is complete. Also stamps app_config.last_backup_at. Runs with a 60s statement timeout (function-scoped) so a cold-cache first run does not hit the role 8s limit. Powers Settings → Back up all data.';
