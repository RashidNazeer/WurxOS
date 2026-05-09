-- ============================================================
-- Migration 130 — Widen campaigns.status CHECK for v1 verbatim port
--
-- v1's CampaignTrackerPage writes the literal status value
-- chosen by the user OR derived by parsePastedData() — one of
-- 'Ongoing' / 'Upcoming' / 'Ended' / 'Deactivated'. v2's 071
-- migration narrowed this to ('Ongoing','Deactivated') because
-- v2 derives Upcoming/Ended client-side from start/end times.
--
-- The verbatim port keeps the v1 markup which writes all 4 values
-- directly. Widen the CHECK so those inserts succeed. effectiveStatus()
-- is still the source of truth for what's *displayed* — this just
-- accepts a broader set of stored values.
-- ============================================================

alter table public.campaigns drop constraint if exists campaigns_status_check;

alter table public.campaigns
  add constraint campaigns_status_check
  check (status in ('Ongoing','Upcoming','Ended','Deactivated'));
