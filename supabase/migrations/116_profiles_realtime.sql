-- ============================================================
-- Migration 116 — Enable Realtime on public.profiles
--
-- AuthContext (src/contexts/AuthContext.jsx) subscribes to
-- postgres_changes on the signed-in user's profile row so that
-- reassignments via team_move_* RPCs (reports_to flips, role
-- changes, soft-delete) propagate to every open tab without a
-- manual refresh. RLS on profiles already restricts what the
-- subscriber sees, so adding the table to supabase_realtime is
-- safe — clients only receive events for rows they can SELECT.
-- ============================================================

alter publication supabase_realtime add table public.profiles;
