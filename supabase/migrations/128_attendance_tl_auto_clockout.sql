-- ============================================================
-- Migration 128 — TL "auto-clock-out" toggle on attendance row.
--
-- v1's ClockWidget lets a TL toggle a per-day flag on their own
-- attendance row + leave a note for their APCs. APCs see this
-- when they hit Clock-Out: if their TL has set auto_clock_out,
-- the APC clocks out without needing approval (and the note
-- explains why the TL is offline). The flag lives on the TL's
-- own daily attendance row — pure metadata, doesn't affect work
-- time math.
--
-- Columns are nullable; defaults match "off". A TL editing their
-- own row updates these directly via existing att_select policy
-- (already lets self update). No new RPC needed.
-- ============================================================

alter table public.attendance
  add column if not exists auto_clock_out      boolean,
  add column if not exists auto_clock_out_note text;

-- Idempotent default: any pre-existing row stays NULL (treated
-- as "off") so this is safe to re-run.
