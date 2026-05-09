-- ============================================================
-- 110 — Add legacy_id columns for v1↔v2 sync orphan detection.
--
-- Each migrated table gets a nullable text column holding the
-- original Firestore doc ID. After a sync run we can delete rows
-- whose legacy_id is set but no longer appears in v1, without
-- touching v2-native rows (which have legacy_id = NULL).
--
-- Backfill: existing migrated rows already have UUIDs derived
-- via fbDocIdToUuid(). We can't reverse that (it's a one-way hash),
-- so the backfill happens at next sync — each step now writes
-- legacy_id alongside id during upsert.
-- ============================================================

alter table public.brands              add column if not exists legacy_id text;
alter table public.tasks               add column if not exists legacy_id text;
alter table public.kb_articles         add column if not exists legacy_id text;
alter table public.attendance          add column if not exists legacy_id text;
alter table public.leave_requests      add column if not exists legacy_id text;
alter table public.product_campaigns   add column if not exists legacy_id text;
alter table public.brand_products      add column if not exists legacy_id text;
alter table public.incentives          add column if not exists legacy_id text;
alter table public.reminders           add column if not exists legacy_id text;
alter table public.suggestions         add column if not exists legacy_id text;
alter table public.changes             add column if not exists legacy_id text;
alter table public.reports             add column if not exists legacy_id text;
alter table public.resources           add column if not exists legacy_id text;
alter table public.campaigns           add column if not exists legacy_id text;
alter table public.performance_ratings add column if not exists legacy_id text;
alter table public.performance_flags   add column if not exists legacy_id text;
alter table public.bug_reports         add column if not exists legacy_id text;

-- Indexes for fast "delete where legacy_id not in (...)" lookups
create index if not exists brands_legacy_idx              on public.brands(legacy_id)              where legacy_id is not null;
create index if not exists tasks_legacy_idx               on public.tasks(legacy_id)               where legacy_id is not null;
create index if not exists kb_articles_legacy_idx         on public.kb_articles(legacy_id)         where legacy_id is not null;
create index if not exists attendance_legacy_idx          on public.attendance(legacy_id)          where legacy_id is not null;
create index if not exists leave_requests_legacy_idx      on public.leave_requests(legacy_id)      where legacy_id is not null;
create index if not exists product_campaigns_legacy_idx   on public.product_campaigns(legacy_id)   where legacy_id is not null;
create index if not exists brand_products_legacy_idx      on public.brand_products(legacy_id)      where legacy_id is not null;
create index if not exists incentives_legacy_idx          on public.incentives(legacy_id)          where legacy_id is not null;
create index if not exists reminders_legacy_idx           on public.reminders(legacy_id)           where legacy_id is not null;
create index if not exists suggestions_legacy_idx         on public.suggestions(legacy_id)         where legacy_id is not null;
create index if not exists changes_legacy_idx             on public.changes(legacy_id)             where legacy_id is not null;
create index if not exists reports_legacy_idx             on public.reports(legacy_id)             where legacy_id is not null;
create index if not exists resources_legacy_idx           on public.resources(legacy_id)           where legacy_id is not null;
create index if not exists campaigns_legacy_idx          on public.campaigns(legacy_id)          where legacy_id is not null;
create index if not exists performance_ratings_legacy_idx on public.performance_ratings(legacy_id) where legacy_id is not null;
create index if not exists performance_flags_legacy_idx   on public.performance_flags(legacy_id)   where legacy_id is not null;
create index if not exists bug_reports_legacy_idx         on public.bug_reports(legacy_id)         where legacy_id is not null;
