-- ============================================================
-- 410 — Weekly database backup (Owner, 2026-10-02).
--
-- Every Sunday the whole operational database is exported to a PRIVATE storage
-- bucket as gzipped NDJSON, one file per table, with a manifest. The ingestion
-- and vector data is deliberately NOT backed up: it is rebuilt by re-ingesting
-- (runbook-backup.md).
--
--   storage bucket db-backups      private; service role only (no policies).
--   backup_config                  one row: enabled, exclude list, keep_weeks.
--   backup_runs                    one row per run: status, tables, rows, bytes,
--                                  path, cursor (resume), lease (one worker).
--   backup_tables()                the tables to export, with their primary key.
--   backup_page(tbl, after, limit) one keyset page as jsonb (service only).
--   backup_start(trigger)          opens a run (guards: enabled, not running, not too soon).
--   backup_lease / _save / _finish the resumable worker's state.
--   backup_old_prefixes(weeks)     day folders past retention, for the worker to delete.
--   run_db_backup()                manual trigger: the Boss or an active developer.
--   backup_tick()                  every minute: continues a 'partial' run.
--
-- Jobs (pg_cron runs in GMT):
--   db-backup-start  0 2 * * 0   Sunday 02:00 GMT = 07:00 PKT, clear of the
--                                Saturday-night TikTok crawl.
--   db-backup-tick   * * * * *   only posts while a run is unfinished.
-- app_config.backup_url is inserted EMPTY: set it after deploying the function
-- (empty → the cron jobs are a no-op). The secret is app_config.ai_ingest_secret.
-- Pause: select cron.unschedule('db-backup-start');  Idempotent.
-- ============================================================

-- ── the bucket: private, no policies, so only the service role reaches it ──
insert into storage.buckets (id, name, public) values ('db-backups', 'db-backups', false)
on conflict (id) do update set public = false;

-- ── config ────────────────────────────────────────────────────────────────
create table if not exists public.backup_config (
  id             int primary key default 1 check (id = 1),
  backup_enabled boolean not null default true,
  -- The ingestion / vector store: big, derived, and rebuilt by re-ingesting.
  backup_exclude text[] not null default array[
    'ai_chunks', 'ai_documents', 'ai_ingest_queue', 'ai_ingest_runs', 'ai_crawl_items',
    'ai_crawl_records', 'ai_crawl_state', 'ai_vector_state', 'tts_articles', 'tts_knowledge',
    'ai_model_catalog'],
  backup_keep_weeks int not null default 8 check (backup_keep_weeks between 1 and 520),
  updated_at     timestamptz not null default now(),
  updated_by     uuid references public.profiles(id) on delete set null
);
insert into public.backup_config (id) values (1) on conflict (id) do nothing;

alter table public.backup_config enable row level security;
revoke all on public.backup_config from anon, authenticated;
grant select on public.backup_config to authenticated;
drop policy if exists "backup_config_read" on public.backup_config;
create policy "backup_config_read" on public.backup_config for select
  using (public.ai_can_view_settings(auth.uid()));

-- ── runs ──────────────────────────────────────────────────────────────────
create table if not exists public.backup_runs (
  id           bigserial primary key,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  status       text not null default 'running' check (status in ('running', 'partial', 'done', 'failed')),
  trigger      text,                                    -- 'schedule' | 'manual' | 'api'
  path         text,                                    -- 'YYYY-MM-DD'
  tables       jsonb not null default '[]'::jsonb,       -- [{table, rows, bytes, parts}]
  rows         bigint not null default 0,
  bytes        bigint not null default 0,
  cursor       jsonb not null default '{}'::jsonb,       -- {table, after, part} — where to resume
  lease_owner  text,
  lease_until  timestamptz,
  last_error   text,
  updated_at   timestamptz not null default now()
);
create index if not exists backup_runs_started_idx on public.backup_runs (started_at desc);
create unique index if not exists backup_runs_one_open_idx on public.backup_runs ((status in ('running', 'partial')))
  where status in ('running', 'partial');

alter table public.backup_runs enable row level security;
revoke all on public.backup_runs from anon, authenticated;
grant select on public.backup_runs to authenticated;
drop policy if exists "backup_runs_read" on public.backup_runs;
create policy "backup_runs_read" on public.backup_runs for select
  using (public.ai_can_view_settings(auth.uid()));

-- ── which tables, and how to page them ────────────────────────────────────
-- Every base table of `public` except the exclude list and our own run log.
-- pk: the primary key columns, in order — the keyset the worker pages by.
create or replace function public.backup_tables()
returns table (table_name text, pk text[], est_rows bigint)
language sql stable security definer
set search_path = public
as $$
  with ex as (
    select coalesce((select c.backup_exclude from public.backup_config c where c.id = 1), '{}') || array['backup_runs'] as list
  )
  select c.relname::text,
         coalesce((select array_agg(a.attname::text order by k.ord)
                     from pg_index i
                     join lateral unnest(i.indkey) with ordinality as k(attnum, ord) on true
                     join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
                    where i.indrelid = c.oid and i.indisprimary), '{}') as pk,
         greatest(c.reltuples::bigint, 0)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join ex
   where n.nspname = 'public' and c.relkind = 'r'
     and not (c.relname::text = any(ex.list))
   order by c.relname;
$$;
revoke execute on function public.backup_tables() from public, anon, authenticated;
grant  execute on function public.backup_tables() to service_role;

-- One page of a table, as a jsonb array of row objects, after the given key.
-- Keyset pagination on the primary key (row-wise, so composite keys work);
-- a table without a primary key is read in one page, ordered by every column.
-- SECURITY DEFINER on purpose: a backup must see every row, RLS aside. Service
-- role only. p_table is matched against backup_tables(), then quoted.
create or replace function public.backup_page(p_table text, p_after jsonb default null, p_limit int default 2000)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_pk    text[];
  v_cols  text;
  v_where text := '';
  v_sql   text;
  v_out   jsonb;
begin
  select t.pk into v_pk from public.backup_tables() t where t.table_name = p_table;
  if not found then raise exception 'backup_page: % is not a backed-up table', p_table; end if;

  if cardinality(v_pk) > 0 then
    v_cols := (select string_agg(format('t.%I', c), ', ') from unnest(v_pk) c);
    if p_after is not null then
      v_where := format('where (%s) > (%s)', v_cols, (select string_agg(format('a.%I', c), ', ') from unnest(v_pk) c));
    end if;
  else
    v_cols := (select string_agg(format('t.%I', a.attname), ', ' order by a.attnum)
                 from pg_attribute a where a.attrelid = format('public.%I', p_table)::regclass and a.attnum > 0 and not a.attisdropped);
  end if;

  v_sql := format(
    'select coalesce(jsonb_agg(to_jsonb(x) order by %s), ''[]''::jsonb) from (
       select t.* from public.%I t, jsonb_populate_record(null::public.%I, coalesce($1, ''{}''::jsonb)) a
        %s order by %s limit $2) x(%s)',
    (select string_agg(format('x.%I', c), ', ') from unnest(case when cardinality(v_pk) > 0 then v_pk else '{}' end) c),
    p_table, p_table, v_where, v_cols,
    (select string_agg(quote_ident(a.attname), ', ' order by a.attnum)
       from pg_attribute a where a.attrelid = format('public.%I', p_table)::regclass and a.attnum > 0 and not a.attisdropped));
  -- No primary key: one page, any order (nothing to resume from).
  if cardinality(v_pk) = 0 then
    v_sql := format('select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb) from public.%I t', p_table);
    execute v_sql into v_out;
    return jsonb_build_object('rows', v_out, 'pk', to_jsonb(v_pk), 'complete', true);
  end if;

  execute v_sql into v_out using p_after, greatest(1, least(coalesce(p_limit, 2000), 20000));
  return jsonb_build_object(
    'rows', v_out,
    'pk', to_jsonb(v_pk),
    'last', case when jsonb_array_length(v_out) > 0
                 then (select jsonb_object_agg(k, (v_out -> (jsonb_array_length(v_out) - 1)) -> k) from unnest(v_pk) k) end,
    'complete', jsonb_array_length(v_out) < greatest(1, least(coalesce(p_limit, 2000), 20000)));
end;
$$;
revoke execute on function public.backup_page(text, jsonb, int) from public, anon, authenticated;
grant  execute on function public.backup_page(text, jsonb, int) to service_role;

-- What the manifest records besides the table list.
create or replace function public.backup_meta()
returns jsonb
language sql stable security definer
set search_path = public
as $$
  select jsonb_build_object(
    'database', current_database(),
    'schema_version', (select max(m.version) from supabase_migrations.schema_migrations m),
    'excluded', to_jsonb(coalesce((select c.backup_exclude from public.backup_config c where c.id = 1), '{}')),
    'keep_weeks', (select c.backup_keep_weeks from public.backup_config c where c.id = 1),
    'generated_at', now());
$$;
revoke execute on function public.backup_meta() from public, anon, authenticated;
grant  execute on function public.backup_meta() to service_role;

-- ── the run's lifecycle ───────────────────────────────────────────────────
-- Opens a run unless backups are off, one is already open, or the last one
-- started less than 6 hours ago (the same shape as ai_run_ingestion's guards).
create or replace function public.backup_start(p_trigger text default 'schedule')
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_enabled boolean;
  v_open    public.backup_runs;
  v_last    timestamptz;
  v_id      bigint;
  v_day     text := (now() at time zone 'Asia/Karachi')::date::text;
begin
  select c.backup_enabled into v_enabled from public.backup_config c where c.id = 1;
  if not coalesce(v_enabled, false) then return jsonb_build_object('status', 'disabled'); end if;

  select * into v_open from public.backup_runs where status in ('running', 'partial')
   order by started_at desc limit 1;
  if found then
    -- A run whose worker died (no lease for 10 minutes) is picked up again, not duplicated.
    return jsonb_build_object('status', 'already_running', 'id', v_open.id, 'run_status', v_open.status,
                              'started_at', v_open.started_at, 'path', v_open.path);
  end if;

  select max(started_at) into v_last from public.backup_runs;
  if v_last > now() - interval '6 hours' and p_trigger <> 'force' then
    return jsonb_build_object('status', 'too_soon', 'last_started_at', v_last, 'next_allowed_at', v_last + interval '6 hours');
  end if;

  insert into public.backup_runs (status, trigger, path, cursor)
  values ('running', coalesce(nullif(p_trigger, 'force'), 'manual'), v_day, '{}'::jsonb)
  returning id into v_id;
  return jsonb_build_object('status', 'started', 'id', v_id, 'path', v_day);
end;
$$;
revoke execute on function public.backup_start(text) from public, anon, authenticated;
grant  execute on function public.backup_start(text) to service_role;

-- Claim the open run. Null when there is none, or another worker holds it.
create or replace function public.backup_lease(p_worker text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare v jsonb;
begin
  update public.backup_runs
     set lease_owner = p_worker, lease_until = now() + interval '4 minutes', status = 'running', updated_at = now()
   where id = (select r.id from public.backup_runs r
                where r.status in ('running', 'partial') and (r.lease_until is null or r.lease_until < now())
                order by r.started_at desc limit 1)
  returning jsonb_build_object('id', id, 'path', path, 'cursor', cursor, 'tables', tables,
                               'rows', rows, 'bytes', bytes, 'started_at', started_at) into v;
  return v;
end;
$$;
revoke execute on function public.backup_lease(text) from public, anon, authenticated;
grant  execute on function public.backup_lease(text) to service_role;

-- Progress: where to resume, and what has been written so far.
create or replace function public.backup_save(p_id bigint, p_worker text, p_cursor jsonb, p_tables jsonb,
                                              p_rows bigint, p_bytes bigint, p_partial boolean default true)
returns boolean
language plpgsql security definer
set search_path = public
as $$
begin
  update public.backup_runs
     set cursor = coalesce(p_cursor, '{}'::jsonb), tables = coalesce(p_tables, tables),
         rows = coalesce(p_rows, rows), bytes = coalesce(p_bytes, bytes),
         status = case when p_partial then 'partial' else status end,
         -- Handing the run back (partial) releases the lease; a progress save
         -- between tables keeps it, and extends it while the worker runs.
         lease_owner = case when p_partial then null else lease_owner end,
         lease_until = case when p_partial then null else now() + interval '4 minutes' end,
         updated_at = now()
   where id = p_id and lease_owner = p_worker;
  return found;
end;
$$;
revoke execute on function public.backup_save(bigint, text, jsonb, jsonb, bigint, bigint, boolean) from public, anon, authenticated;
grant  execute on function public.backup_save(bigint, text, jsonb, jsonb, bigint, bigint, boolean) to service_role;

create or replace function public.backup_finish(p_id bigint, p_status text, p_tables jsonb default null,
                                                p_rows bigint default null, p_bytes bigint default null, p_error text default null)
returns boolean
language plpgsql security definer
set search_path = public
as $$
begin
  if p_status not in ('done', 'failed') then raise exception 'backup_finish: status must be done or failed'; end if;
  update public.backup_runs
     set status = p_status, finished_at = now(), tables = coalesce(p_tables, tables),
         rows = coalesce(p_rows, rows), bytes = coalesce(p_bytes, bytes),
         last_error = left(p_error, 2000), lease_owner = null, lease_until = null, updated_at = now()
   where id = p_id;
  return found;
end;
$$;
revoke execute on function public.backup_finish(bigint, text, jsonb, bigint, bigint, text) from public, anon, authenticated;
grant  execute on function public.backup_finish(bigint, text, jsonb, bigint, bigint, text) to service_role;

-- Day folders past retention (the worker deletes their objects).
create or replace function public.backup_old_prefixes(p_keep_weeks int default null)
returns setof text
language sql stable security definer
set search_path = public
as $$
  select distinct r.path
    from public.backup_runs r
   where r.status = 'done' and r.path is not null
     and r.path::date < ((now() at time zone 'Asia/Karachi')::date
                         - (coalesce(p_keep_weeks, (select c.backup_keep_weeks from public.backup_config c where c.id = 1), 8) * 7))
   order by r.path;
$$;
revoke execute on function public.backup_old_prefixes(int) from public, anon, authenticated;
grant  execute on function public.backup_old_prefixes(int) to service_role;

-- ── triggers: manual and cron ─────────────────────────────────────────────
create or replace function public.backup_post(p_mode text)
returns void
language plpgsql security definer
set search_path = public, net
as $$
declare v_url text; v_secret text;
begin
  select value into v_url    from public.app_config where key = 'backup_url';
  select value into v_secret from public.app_config where key = 'ai_ingest_secret';
  if coalesce(v_url, '') = '' then return; end if;
  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', coalesce(v_secret, '')),
    body := jsonb_build_object('mode', p_mode),
    timeout_milliseconds := 150000);
end;
$$;
revoke execute on function public.backup_post(text) from public, anon, authenticated;

-- The Boss or an active developer; no JWT at all is a direct database session
-- (SQL editor), which only the owner has. Same shape as ai_run_ingestion.
create or replace function public.run_db_backup()
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_role text := nullif(auth.role(), '');
  v_out  jsonb;
begin
  if v_role = 'service_role' then
    null;
  elsif v_uid is null and v_role is null and session_user in ('postgres', 'supabase_admin') then
    null;
  elsif v_uid is null or not public.ai_can_view_settings(v_uid) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  v_out := public.backup_start('manual');
  if v_out->>'status' = 'started' then perform public.backup_post('continue'); end if;
  return v_out;
end;
$$;
revoke execute on function public.run_db_backup() from public, anon;
grant  execute on function public.run_db_backup() to authenticated, service_role;

-- Sunday: open a run and kick the worker.
create or replace function public.backup_start_weekly()
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare v jsonb;
begin
  v := public.backup_start('schedule');
  if v->>'status' in ('started', 'already_running') then perform public.backup_post('continue'); end if;
  return v;
exception when others then
  raise warning 'backup_start_weekly failed: %', sqlerrm;
  return jsonb_build_object('status', 'error', 'error', left(sqlerrm, 300));
end;
$$;
revoke execute on function public.backup_start_weekly() from public, anon, authenticated;

-- Every minute, but only while a run is unfinished and unleased.
create or replace function public.backup_tick()
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.backup_runs r
                  where r.status in ('running', 'partial')
                    and (r.lease_until is null or r.lease_until < now())) then
    return;
  end if;
  perform public.backup_post('continue');
exception when others then
  raise warning 'backup_tick failed: %', sqlerrm;
end;
$$;
revoke execute on function public.backup_tick() from public, anon, authenticated;

insert into public.app_config (key, value) values ('backup_url', '') on conflict (key) do nothing;

select cron.schedule('db-backup-start', '0 2 * * 0', 'select public.backup_start_weekly()');
select cron.schedule('db-backup-tick',  '* * * * *', 'select public.backup_tick()');
