-- ============================================================
-- WurxOS v2 — Migration 442: brands outside the 2026-11-05 team structure go inactive
--
-- Only 16 brands are in the structure sheet. Every other brand is marked
-- inactive (21 already were; Kenashii and Klassy Network were the last two active).
-- Idempotent.
-- ============================================================

update public.brands
   set status = 'inactive'
 where status <> 'inactive'
   and brand_name not in (
     'Swisse', 'Honeysticks', 'Apothecary', 'Inno Supps', 'Dr Tobias', 'Biostime Shop US',
     'Penetrex', 'Irwin Naturals', 'Dr. Harvey''s', 'Aqua Sonic', 'Mineral Ice Extreme',
     'Cutler Nutritions', 'JoyMode', 'Bentgo', 'YesDay', 'Pure Daily Care');
