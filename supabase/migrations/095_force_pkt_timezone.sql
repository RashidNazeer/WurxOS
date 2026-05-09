-- ============================================================
-- Migration 095 — Lock all profile timezones to Asia/Karachi
--
-- WurxOS is operated entirely from Pakistan, so every saved time
-- (tier notifications, task resets, campaign expiry hour, etc.)
-- should be interpreted as PKT regardless of the user's OS clock.
-- This kills three sources of drift:
--   * Browser/OS timezone disagreeing with intended company time
--   * profiles.timezone defaulting to UTC for new signups
--   * Per-user picker (didn't exist) needed for self-service
--
-- Approach: bulk-set every existing profile to 'Asia/Karachi',
-- change the column DEFAULT, and add a CHECK so any future
-- write to a different value fails loudly. If you ever need to
-- revisit (someone genuinely working from another country), drop
-- the CHECK in a follow-up migration.
-- ============================================================

-- 1. Bulk-set all existing rows.
update public.profiles
   set timezone = 'Asia/Karachi'
 where coalesce(timezone, '') <> 'Asia/Karachi';

-- 2. Update the column default for any new signups.
alter table public.profiles
  alter column timezone set default 'Asia/Karachi';

-- 3. Lock it via CHECK so app code or scripts can't accidentally
--    write a different value. If a future need to support multiple
--    zones arises, drop this constraint first.
alter table public.profiles
  drop constraint if exists profiles_timezone_pkt;

alter table public.profiles
  add constraint profiles_timezone_pkt
    check (timezone = 'Asia/Karachi');

-- 4. handle_new_user() trigger: make sure new signups get the right
--    default even if the trigger explicitly inserts a value. We re-stamp
--    the function but only override the timezone field; the rest of the
--    body lives in earlier migrations and we keep it intact.
--    The simpler fix: rely on the column default, and ensure no caller
--    is sending an explicit timezone='UTC'. Verified by code search —
--    handle_new_user does not set timezone explicitly.
