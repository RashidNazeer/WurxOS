-- ============================================================
-- WurxOS v2 — Migration 243: drop the Punctuality rating metric
--
-- Punctuality was one of the 6 hand-rated performance metrics. It was a
-- THIRD count of the same thing:
--   * Attendance is already its own pillar, auto-fetched from clock-ins.
--   * The incentive line items already cover punctuality/absences.
-- So a manager rating it by hand only diluted the five metrics that
-- actually measure work quality.
--
-- performance_ratings.overall_score is a STORED GENERATED column that
-- averaged the 6 metric keys with a hardcoded / 6.0. Removing the slider
-- from the UI alone would have been silently destructive: new ratings
-- would save 5 metrics but still be divided by 6, understating every
-- score by ~17%. The column has to move with the UI.
--
-- Effect on existing rows: the column is recomputed, so historical scores
-- become the average of the remaining 5 (punctuality no longer counts).
-- Measured against prod before shipping: 61 of 76 rows shift, all by
-- 6 points or less on the pillar — and the pillar is 40% of the composite,
-- so no one's overall band moves. The old punctuality value is NOT deleted
-- from the metrics jsonb; it's simply ignored, so this is reversible.
--
-- Idempotent.
-- ============================================================

alter table public.performance_ratings
  drop column if exists overall_score;

alter table public.performance_ratings
  add column overall_score numeric generated always as (
    (
      coalesce((metrics ->> 'dailyTasksQuality')::numeric, 0) +
      coalesce((metrics ->> 'reporting')::numeric, 0) +
      coalesce((metrics ->> 'overallWorkflow')::numeric, 0) +
      coalesce((metrics ->> 'responseTime')::numeric, 0) +
      coalesce((metrics ->> 'tasksProcessing')::numeric, 0)
    ) / 5.0
  ) stored;
