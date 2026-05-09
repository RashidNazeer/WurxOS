-- ============================================================
-- 113 — One-shot cleanup: drop membership rows for users that
-- were soft-deleted before the delete-user Edge Function was
-- updated to do this automatically.
--
-- Affected tables (the same set the updated Edge Function now
-- cleans on every delete):
--   * brand_assignments       — the bug being fixed
--   * pctl_brand_selections   — PCTL's selected brand list
--   * chat_members            — chat membership
--   * kb_acknowledgments      — KB ack rows
--   * suggestion_upvotes      — their upvotes
--
-- Reads profiles.deleted_at IS NOT NULL to find the targets.
-- Tables that hold attribution (created_by/author_id/etc.) are
-- intentionally left alone — historical work should still attribute
-- correctly.
--
-- Re-running this migration is safe (already-deleted rows are simply
-- not present on the second run).
-- ============================================================

with deleted_users as (
  select id from public.profiles where deleted_at is not null
)
delete from public.brand_assignments
 where user_id in (select id from deleted_users);

with deleted_users as (
  select id from public.profiles where deleted_at is not null
)
delete from public.pctl_brand_selections
 where pctl_id in (select id from deleted_users);

with deleted_users as (
  select id from public.profiles where deleted_at is not null
)
delete from public.chat_members
 where user_id in (select id from deleted_users);

with deleted_users as (
  select id from public.profiles where deleted_at is not null
)
delete from public.kb_acknowledgments
 where user_id in (select id from deleted_users);

with deleted_users as (
  select id from public.profiles where deleted_at is not null
)
delete from public.suggestion_upvotes
 where user_id in (select id from deleted_users);
