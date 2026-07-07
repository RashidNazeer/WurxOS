-- ============================================================
-- WurxOS v2 — Migration 231: exclude tts_knowledge from the full-data backup.
--
-- The Boss's "Back up all data" started timing out again (intermittently
-- "statement timeout" or "upstream request timeout"). Root cause: the AI
-- assistant's knowledge base, `tts_knowledge`, grew to ~2,900 rows — each row
-- carries a pgvector embedding that serializes to ~24 KB of JSON. That ONE
-- table is ~67 MB, i.e. ~89% of the entire ~75 MB export. Building and
-- returning a 75 MB JSONB blob in a single RPC blows past both the function's
-- statement timeout AND the API gateway's (non-configurable) response timeout.
--
-- Fix: add `tts_knowledge` to the skip-list. It is REGENERABLE, derived data —
-- rebuilt offline by the ingest pipeline (scripts/tts-ingest/), exactly the
-- same category as `euka_api_cache` (already skipped). Excluding it drops the
-- export from ~75 MB to ~8.5 MB — below the ~16 MB that historically exported
-- in ~2.7s — so the backup is fast and reliable again. No business data is
-- lost: if the KB is ever wiped, re-run the ingest to rebuild the embeddings.
--
-- Body is otherwise IDENTICAL to migration 220 (same 60s function-scoped
-- statement timeout, same runtime table discovery); only `tts_knowledge` is
-- added to v_skip and the notes/comment updated.
-- ============================================================

create or replace function public.export_all_data()
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '60s'
as $$
declare
  v_actor        uuid := auth.uid();
  v_caller_role  text;
  v_caller_active boolean;
  v_skip         text[] := array[
    'audit_log', 'app_events', 'euka_api_cache',
    'push_subscriptions', 'app_config',
    -- Regenerable AI knowledge-base embeddings (~67 MB, rebuilt by the offline
    -- ingest pipeline). Kept OUT of the backup so a single derived table can't
    -- push the export past the request-timeout ceiling. See migration note.
    'tts_knowledge'
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
  'Boss-only. Returns a complete { meta, data } JSON snapshot of every business table in public (discovered at runtime; skips logs/cache/config-with-secrets and the regenerable tts_knowledge AI-KB embeddings), bypassing RLS so the backup is complete. Also stamps app_config.last_backup_at. 60s function-scoped statement timeout. Powers Settings → Back up all data.';
