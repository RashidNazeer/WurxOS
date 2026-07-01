-- ============================================================
-- WurxOS v2 — Migration 219: Boss-only full-data export (manual backup).
--
-- Powers the Settings → "Back up all data" button. Returns ONE complete
-- snapshot of every business table as JSON, so if data is ever lost or
-- deleted the file can be re-imported to recover it.
--
-- Design notes (why this shape):
--   * SECURITY DEFINER, Boss-gated. We must dump EVERY row of EVERY table
--     regardless of RLS — a client-side export would be silently filtered
--     by RLS (Boss can't SELECT every user's notifications/chat/etc.) and
--     produce an INCOMPLETE backup. That is the one thing this feature
--     must never do, so the dump runs server-side with definer rights.
--   * Tables are discovered at RUNTIME from information_schema, not a
--     hand-maintained list. As new tables are added in future migrations
--     they are AUTOMATICALLY included — nothing can silently drift out of
--     the backup. (Same self-healing philosophy as wipe_all_operational_data.)
--   * A small explicit skip-list is excluded on purpose:
--       audit_log, app_events        — forensic/telemetry logs (huge, not
--                                       recoverable business data)
--       euka_api_cache               — regenerable API cache
--       push_subscriptions           — per-device push tokens (regenerate on
--                                       next login; not business data)
--       app_config                   — system config; contains secrets
--                                       (push secret, webhook) that must NOT
--                                       land in a file uploaded to Drive
--     Everything else — every actual piece of business data — is included.
--   * Stamps app_config.last_backup_at as part of the same call, so the
--     timestamp only advances when a real export actually ran.
--
-- Restore is intentionally out of scope of this function: the file is the
-- safety copy; re-importing it is a deliberate manual/developer operation.
-- The format is a plain { meta, data } object so it stays cleanly importable.
-- ============================================================

create or replace function public.export_all_data()
returns jsonb
language plpgsql
security definer
set search_path = public
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
  'Boss-only. Returns a complete { meta, data } JSON snapshot of every business table in public (discovered at runtime; skips logs/cache/config-with-secrets), bypassing RLS so the backup is complete. Also stamps app_config.last_backup_at. Powers Settings → Back up all data.';
