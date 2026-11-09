-- ============================================================
-- WurxOS v2 — Migration 450: "Videos with $100+ GMV" is retired as an incentive / bonus.
--
-- The picker no longer offers it (code change, option kept only so past plans still read).
-- Plans copy their lines forward each month (inc_reset_and_roll), so a line left on a plan that is
-- still open would reappear next month. This removes it from every plan from November 2026 that
-- is NOT verified yet. Verified plans and anything before November are history and are untouched.
-- One-shot (triggers do not run retroactively).
-- ============================================================
update public.incentives i
   set incentives = coalesce((select jsonb_agg(it) from jsonb_array_elements(coalesce(i.incentives, '[]'::jsonb)) it
                               where coalesce(it ->> 'wbOption', '') <> 'videos_100_gmv'
                                 and lower(coalesce(it ->> 'text', '')) <> 'videos with $100+ gmv'), '[]'::jsonb),
       bonuses    = coalesce((select jsonb_agg(it) from jsonb_array_elements(coalesce(i.bonuses, '[]'::jsonb)) it
                               where coalesce(it ->> 'wbOption', '') <> 'videos_100_gmv'
                                 and lower(coalesce(it ->> 'text', '')) <> 'videos with $100+ gmv'), '[]'::jsonb)
 where i.month >= '2026-11'
   and coalesce(i.verified, false) = false
   and (lower(i.incentives::text) like '%videos with $100+ gmv%' or lower(i.bonuses::text) like '%videos with $100+ gmv%'
        or i.incentives::text like '%videos_100_gmv%' or i.bonuses::text like '%videos_100_gmv%');
