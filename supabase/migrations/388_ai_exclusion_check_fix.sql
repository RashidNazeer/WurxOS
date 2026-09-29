-- ============================================================
-- 388 — Assistant v2: fix 384's check on ai_excluded_documents.
--
-- 384's constraint called public.ai_source_canon(), which authenticated
-- cannot execute (it is service-only, and stays so). A check constraint runs
-- as the inserting user, so the Boss adding an exclusion from the app failed
-- with 42501. The six known types are now written into the constraint
-- itself: no function, nothing to grant. Keep the list in step with
-- ai_source_canon() (mig 379).  Idempotent.
-- ============================================================

alter table public.ai_excluded_documents drop constraint if exists ai_excluded_documents_source_type_known;
alter table public.ai_excluded_documents add constraint ai_excluded_documents_source_type_known
  check (source_type in ('kb_article', 'ai_doc', 'app_guide', 'tts_article', 'report', 'incentive'));
