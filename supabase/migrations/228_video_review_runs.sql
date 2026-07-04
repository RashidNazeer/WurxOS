-- ============================================================
-- WurxOS v2 — Migration 228: video_review_runs log.
--
-- Records every "Video Reviews" generation run: the target date, the
-- (optional, max 2) missed run dates, per-group creator counts, who ran it.
-- Purposes: (1) history / audit, (2) a future basis for AUTO missed-date
-- tracking (the system can see which target dates it already ran, so it can
-- offer the gaps as missed dates instead of the APC entering them by hand).
--
-- The actual creator handle lists are NOT stored — they're generated fresh
-- from live Euka data each run and downloaded as CSV; only counts are kept.
-- ============================================================

create table if not exists public.video_review_runs (
  id            uuid primary key default gen_random_uuid(),
  brand_slug    text not null,
  brand_label   text,
  target_date   date not null,
  missed_dates  date[] not null default '{}',
  group1_count  int not null default 0,
  group2_count  int not null default 0,
  group3_count  int not null default 0,
  candidates    int not null default 0,
  needs_manual  int not null default 0,
  run_by        uuid references public.profiles(id) on delete set null,
  run_by_name   text,
  created_at    timestamptz not null default now()
);

create index if not exists video_review_runs_brand_target_idx
  on public.video_review_runs (brand_slug, target_date desc);
create index if not exists video_review_runs_created_idx
  on public.video_review_runs (created_at desc);

alter table public.video_review_runs enable row level security;

-- The edge function writes with the service role (RLS-exempt). For reads, keep
-- it Boss-only during the pilot (matches the feature's access). Widen later
-- when the feature opens to APCs per-brand.
drop policy if exists video_review_runs_boss_read on public.video_review_runs;
create policy video_review_runs_boss_read
  on public.video_review_runs for select
  using (public.is_boss(auth.uid()));
