-- ============================================================
-- WurxOS v2 — Migration 393: bc_select checks the author on the row
--
-- The first dev apply of mig 391 had bc_select = broadcast_visible(id, uid)
-- only. That helper looks the broadcast up, and a lookup can't see the row
-- its own INSERT ... RETURNING is creating, so createBroadcast
-- (.insert().select()) failed RLS. Mig 391 now has the fixed policy; this
-- re-states it for databases that already ran the first version (dev).
-- A no-op anywhere else. Idempotent.
-- ============================================================

drop policy if exists "bc_select" on public.broadcasts;
create policy "bc_select"
  on public.broadcasts for select
  using (author_id = auth.uid() or public.broadcast_visible(id, auth.uid()));
