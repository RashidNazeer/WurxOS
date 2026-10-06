-- Remove duplicate and test brand rows (Owner request, 2026-10-06).
--
-- WHY the duplicates exist: all five "Honeysticks" rows were created on
-- 2026-10-05 between 10:40:20 and 10:42:03 by the same user, with no dependent
-- rows on any of them. That is the signature of the brand-create failure fixed
-- in mig 412 ("Could not embed brand_assignments and profiles") — the save
-- looked like it errored, so the employee retried, and every retry left a row
-- behind. Keeping the oldest.
--
-- brands has 32 inbound FKs, nearly all ON DELETE CASCADE (reports,
-- weekly_checkpoints, brand_monthly_metrics, gmv_max_reports, campaigns, ...),
-- so this is deliberately keyed on exact ids rather than on brand_name — a
-- name match would be one typo away from cascading a live brand's history.
--
-- Verified before writing this: the 4 dropped Honeysticks rows and Test Brand 2
-- have ZERO dependent rows. "Test Brand" has 13 (3 reports, 5 brand_assignments,
-- 2 weekly_checkpoints, 1 brand_monthly_metrics, 1 brand_report_sections,
-- 1 report_section_presets) and those go with it, as intended for test data.
-- Rollback for all 19 rows: Desktop/ROLLBACK-brand-dedupe.sql.
--
-- These ids exist only in production, so on any other database (dev, a fresh
-- clone) this migration is a deliberate no-op rather than an error — otherwise
-- it would wedge `supabase db push` on dev forever.

do $$
declare
  v_keep uuid := '7da535ae-ae23-4f80-955b-99a14d80b43e';   -- Honeysticks, oldest
  v_drop uuid[] := array[
    '5cb3effa-5242-43da-831d-1a38f847d657',  -- Honeysticks dup (10:40:25)
    '7a0734e2-e036-421f-9ca0-33f6b8362f89',  -- Honeysticks dup (10:41:39)
    '21e6b268-d73a-4c25-8ab7-81f5967d7878',  -- Honeysticks dup (10:41:59)
    'a37a29f8-fa2d-480a-b5fe-e6648e86e52d',  -- Honeysticks dup (10:42:03)
    '23cc54f3-5085-4ff8-88e1-d73882471880',  -- Test Brand
    'ed47bf9b-2af9-4548-afec-b25299222068'   -- Test Brand 2
  ]::uuid[];
  n_deleted int;
  n_honey   int;
  n_test    int;
begin
  -- Not production: leave the database alone.
  if not exists (select 1 from public.brands where id = v_keep) then
    raise notice '413: Honeysticks row to keep not present - skipping (not the production database)';
    return;
  end if;

  delete from public.brands where id = any(v_drop);
  get diagnostics n_deleted = row_count;

  select count(*) into n_honey from public.brands where brand_name = 'Honeysticks';
  select count(*) into n_test  from public.brands where brand_name in ('Test Brand', 'Test Brand 2');

  if n_honey <> 1 then
    raise exception '413: expected exactly 1 Honeysticks after dedupe, found %', n_honey;
  end if;
  if n_test <> 0 then
    raise exception '413: expected 0 test brands after dedupe, found %', n_test;
  end if;

  raise notice '413: deleted % brand row(s); Honeysticks=% test brands=%', n_deleted, n_honey, n_test;
end $$;
