-- ============================================================
-- WurxOS v2 — Migration 233: Amazon Halo Effect explorer
--
-- Boss uploads a daily performance sheet (TikTok Shop + GMV Max metrics
-- plus a few Amazon columns) and the app correlates the two sides to see
-- what TikTok activity drives Amazon demand (the "halo"). Each upload is
-- kept as its own dataset (history), so Boss can switch between / compare
-- uploads over time.
--
-- Data model:
--   * halo_datasets — one row per upload (name, source file, period, counts)
--   * halo_rows     — one row per day per dataset; all metrics live in a
--                     jsonb blob so the column set can flex if the sheet
--                     changes. dummy_fields records which Amazon columns
--                     were backfilled with test data (Keyword Search Volume
--                     / Revenue/Day are empty in the real sheet today).
--
-- Access: BOSS-ONLY (like /euka and the AI assistant). RLS uses is_boss();
-- the upload path is a SECURITY DEFINER RPC so a dataset + all its rows are
-- created atomically. Deletes cascade rows.
-- ============================================================

create table if not exists public.halo_datasets (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  source_filename text,
  period_start    date,
  period_end      date,
  row_count       int  not null default 0,
  has_dummy       boolean not null default false,
  created_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now()
);

create table if not exists public.halo_rows (
  id           uuid primary key default gen_random_uuid(),
  dataset_id   uuid not null references public.halo_datasets(id) on delete cascade,
  date         date not null,
  metrics      jsonb not null default '{}'::jsonb,
  dummy_fields text[] not null default '{}',
  unique (dataset_id, date)
);
create index if not exists halo_rows_dataset_date_idx on public.halo_rows(dataset_id, date);

alter table public.halo_datasets enable row level security;
alter table public.halo_rows     enable row level security;

-- Boss-only, full access (read + write). Everything here is Boss-scoped.
drop policy if exists halo_ds_boss on public.halo_datasets;
create policy halo_ds_boss on public.halo_datasets for all
  using (public.is_boss(auth.uid())) with check (public.is_boss(auth.uid()));

drop policy if exists halo_rows_boss on public.halo_rows;
create policy halo_rows_boss on public.halo_rows for all
  using (public.is_boss(auth.uid())) with check (public.is_boss(auth.uid()));

-- --------------------------------------------------------------
-- Atomic upload: create the dataset + insert every day row in one call.
-- p_rows is a jsonb array of { date, metrics, dummy_fields }.
-- --------------------------------------------------------------
create or replace function public.halo_create_dataset(
  p_name         text,
  p_filename     text,
  p_period_start date,
  p_period_end   date,
  p_rows         jsonb,
  p_has_dummy    boolean default false
) returns public.halo_datasets
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_ds    public.halo_datasets;
  v_count int;
begin
  if not public.is_boss(v_uid) then
    raise exception 'not authorised — Boss only';
  end if;

  insert into public.halo_datasets (
    name, source_filename, period_start, period_end, has_dummy, created_by, row_count
  ) values (
    coalesce(nullif(trim(p_name), ''), 'Untitled dataset'),
    p_filename, p_period_start, p_period_end, coalesce(p_has_dummy, false), v_uid, 0
  ) returning * into v_ds;

  insert into public.halo_rows (dataset_id, date, metrics, dummy_fields)
  select v_ds.id,
         (e ->> 'date')::date,
         coalesce(e -> 'metrics', '{}'::jsonb),
         coalesce(
           (select array_agg(x) from jsonb_array_elements_text(e -> 'dummy_fields') x),
           '{}'::text[]
         )
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) e
  where nullif(e ->> 'date', '') is not null
  on conflict (dataset_id, date) do update
    set metrics = excluded.metrics, dummy_fields = excluded.dummy_fields;

  select count(*)::int into v_count from public.halo_rows where dataset_id = v_ds.id;
  update public.halo_datasets set row_count = v_count where id = v_ds.id returning * into v_ds;

  return v_ds;
end;
$$;
grant execute on function public.halo_create_dataset(text, text, date, date, jsonb, boolean) to authenticated;
