-- ============================================================
-- 371 — Assistant v2: TikTok Shop Academy staging table.
--
-- The crawler (Assistant/scripts/tts-crawl.mjs now; the tts-crawl edge
-- function later) writes one row per article / course lesson here. A trigger
-- (mig 373) enqueues it; the ingest worker chunks, embeds and indexes it like
-- every other source. The crawler never embeds anything itself.
--
-- Replaces the flat tts_knowledge table (mig 223): the new crawl comes from the
-- Academy's own sitemap (988 essays + 41 courses on 2026-09-28, vs 514 essays
-- in the old seed list) and carries richer metadata. tts_knowledge stays for
-- the v1 assistant until cutover.
--
-- Design: Assistant/architecture.md §9.8.  Idempotent.
-- ============================================================

create table if not exists public.tts_articles (
  knowledge_id        text primary key,           -- essay knowledge_id / lesson content_id
  kind                text not null check (kind in ('essay','course_lesson')),
  url                 text not null,
  title               text not null,
  breadcrumb          text,                        -- "Seller > Accounts and Payments"
  course              jsonb,                       -- {learning_id,name,description,lesson_index,lesson_count}
  keywords            text[] not null default '{}',
  applies_to          text,                        -- "Applies to: United States"
  source              text,                        -- "US Academy"
  ai_summary          text,                        -- TikTok's own summary; indexed as an extra chunk
  toc                 jsonb not null default '[]'::jsonb,
  body                text not null,
  views               bigint,
  source_created_at   timestamptz,
  source_modified_at  timestamptz,
  content_hash        text not null,
  first_seen_at       timestamptz not null default now(),
  last_seen_at        timestamptz not null default now(),
  missed_crawls       int not null default 0,      -- retire after 3 consecutive misses
  is_active           boolean not null default true,
  updated_at          timestamptz not null default now()
);
create index if not exists tts_articles_active_idx on public.tts_articles (is_active, kind);

alter table public.tts_articles enable row level security;
drop policy if exists "tts_articles_admin_read" on public.tts_articles;
create policy "tts_articles_admin_read" on public.tts_articles for select
  using (public.is_ai_admin((select auth.uid())));
-- Writes: service role only (crawler / importer).
