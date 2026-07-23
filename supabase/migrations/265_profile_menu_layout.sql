-- ============================================================
-- WurxOS v2 — Migration 265: profiles.menu_layout
--
-- Per-user sidebar layout: which top-level menu entries are pinned and the
-- order the user prefers. Shape: { "order": [key,…], "pinned": [key,…] } where
-- key = the item's `to` path, or "group:<Label>" for a collapsible group.
--
-- It's a pure UI preference over the user's OWN role menu — it can only
-- reorder/pin entries the role already has (enforced client-side by keying off
-- getMenuForRole(role)); it never grants access. Self-writable under the
-- existing profiles UPDATE policy (mig 002 profiles_update_self_or_boss);
-- profiles is already in the realtime publication (mig 116), so a save syncs
-- across the user's devices, and the deleted_at/is_active force-logout guard in
-- AuthContext does not trip on this column.
--
-- Safe to re-run.
-- ============================================================

alter table public.profiles
  add column if not exists menu_layout jsonb not null default '{}'::jsonb;
