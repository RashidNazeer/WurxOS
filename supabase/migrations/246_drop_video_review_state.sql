-- ============================================================
-- WurxOS v2 — Migration 246: revert the Video Review ledger (mig 245)
--
-- Reverted at the Boss's instruction on 2026-07-13, same day it shipped.
--
-- The ledger was built to stop a creator ever being silently missed when Euka
-- delivered their video late. The premise turned out to be far weaker than I
-- claimed: re-measuring Euka hours apart showed the missing Jul-10 videos were
-- NOT trickling in (still 69 of ~150), and the creators TikTok showed
-- (morsekyle, sammyyc1, kelliward10 …) had no record in Euka at all. So those
-- creators are missing from Euka's data outright — a gap only Euka can fix — and
-- a catch-up ledger cannot rescue data that never arrives.
--
-- Meanwhile the ledger itself caused real harm: a rollout-ordering mistake (the
-- stateful logic went live before the ledger was seeded) sent ~54 Biostime
-- creators a duplicate 1st-review message, and a stale ledger row put
-- big_vin425 in a 3rd-review file she had already completed in June.
--
-- Net: unproven benefit, proven cost. Reverted in full. The tool returns to its
-- original stateless behaviour — each target date computed independently from
-- Euka, missed dates handled by the existing missed-date input.
--
-- Drops everything mig 245 created. No other table references these.
-- Idempotent.
-- ============================================================

drop function if exists public.video_review_mark_sent(uuid, text[], int, date);
drop table if exists public.video_review_state;
