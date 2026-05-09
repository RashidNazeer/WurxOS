-- ============================================================
-- WurxOS v2 — Migration 079: profiles.deleted_at (soft delete)
--
-- Adds a soft-delete marker on profiles so the Boss can delete
-- users without breaking RESTRICT FKs (brands.owner_id,
-- reports.author_id). The auth.users row gets soft-deleted by
-- the delete-user Edge Function (which sets auth.users.deleted_at
-- so the user can't sign in), and we mirror that on profiles so
-- the UI can filter them out of management lists.
--
-- Historical FKs (audit log, tasks, brand assignments, etc.)
-- continue to work since the profile row itself stays.
-- ============================================================

alter table public.profiles
  add column if not exists deleted_at timestamptz;

create index if not exists profiles_deleted_at_idx
  on public.profiles(deleted_at)
  where deleted_at is not null;
