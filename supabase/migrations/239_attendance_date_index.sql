-- ============================================================
-- WurxOS v2 — Migration 239: attendance(date) index for roster scans
--
-- The whole-team roster / "today" queries filter on `date` ALONE
-- (e.g. RosterTab .gte('date',start).lte('date',end); getTodayRoster
-- .eq('date', today)). The only date-bearing indexes today are
-- user_id-LEADING composites — attendance_user_date_idx (mig 030) and
-- idx_attendance_user_date_desc (mig 157) — which a bare `date=`/`date BETWEEN`
-- predicate cannot range-seek, so those queries seq-scan the whole table.
-- Attendance grows ~1 row per user per DAY, so this is the one index of the
-- audit's three that actually matters at scale.
--
-- Also drops idx_attendance_user_date_desc: mig 157 added it intending to
-- speed the roster, but it is an exact DUPLICATE of mig 030's
-- attendance_user_date_idx (both (user_id, date desc)) and still user_id-
-- leading, so it never served the date-only scan and only adds write cost.
--
-- Additive + idempotent; safe to re-run. Table is small (sub-second build).
-- ============================================================

create index if not exists idx_attendance_date
  on public.attendance (date);

-- Remove the redundant duplicate index from migration 157 (identical to
-- attendance_user_date_idx from mig 030). Dropping a duplicate is safe —
-- the identical index remains to serve (user_id, date) lookups.
drop index if exists public.idx_attendance_user_date_desc;
