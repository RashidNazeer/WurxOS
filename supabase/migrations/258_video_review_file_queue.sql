-- ============================================================
-- WurxOS v2 — Migration 258: file-based Video Reviews queue.
--
-- A second way to generate the 1st/2nd/3rd video-review creator lists, driven
-- by an uploaded TikTok "all videos" export instead of Euka. The Euka path
-- (video-review-targets edge fn) stays untouched; this is a separate mode.
--
-- Two small tables, both brand-scoped:
--   video_review_settings  — one row per brand: the BASELINE date ("the line").
--                            Videos a creator posted before it count as already
--                            reviewed; only milestones on/after it are messaged.
--   video_review_progress  — the queue's memory: per brand + creator, how many
--                            review messages have been sent (0..3) and the date
--                            of the last one (so we send at most one per day and
--                            never send a 4th). The uploaded file supplies each
--                            creator's video COUNT; this table supplies "sent".
--
-- AuthZ mirrors the Euka video-review feature: the Boss, or an APC ASSIGNED to
-- the brand (brand_assignments). So an APC only ever touches their own brands.
-- ============================================================

-- ── Per-brand baseline ──────────────────────────────────────────────
create table if not exists public.video_review_settings (
  brand_id   uuid primary key references public.brands(id) on delete cascade,
  start_date date not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id)
);

-- ── Per-creator sent tracker (the queue) ────────────────────────────
create table if not exists public.video_review_progress (
  brand_id       uuid not null references public.brands(id) on delete cascade,
  creator        text not null,                              -- normalized lowercase handle
  sent_count     int  not null default 0 check (sent_count between 0 and 3),
  last_sent_date date,
  updated_at     timestamptz not null default now(),
  updated_by     uuid references public.profiles(id),
  primary key (brand_id, creator)
);

-- ── Access check: Boss, or an APC assigned to the brand ─────────────
create or replace function public.can_use_video_reviews(p_brand uuid, uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select
    public.is_boss(uid)
    or exists (
      select 1 from public.brand_assignments ba
      where ba.brand_id = p_brand and ba.user_id = uid
    );
$$;
revoke all on function public.can_use_video_reviews(uuid, uuid) from public, anon;
grant execute on function public.can_use_video_reviews(uuid, uuid) to authenticated;

-- ── RLS ─────────────────────────────────────────────────────────────
alter table public.video_review_settings enable row level security;
alter table public.video_review_progress enable row level security;

drop policy if exists vrs_all on public.video_review_settings;
create policy vrs_all on public.video_review_settings
  for all
  using (public.can_use_video_reviews(brand_id, auth.uid()))
  with check (public.can_use_video_reviews(brand_id, auth.uid()));

drop policy if exists vrp_all on public.video_review_progress;
create policy vrp_all on public.video_review_progress
  for all
  using (public.can_use_video_reviews(brand_id, auth.uid()))
  with check (public.can_use_video_reviews(brand_id, auth.uid()));

grant select, insert, update, delete on public.video_review_settings to authenticated;
grant select, insert, update, delete on public.video_review_progress to authenticated;
