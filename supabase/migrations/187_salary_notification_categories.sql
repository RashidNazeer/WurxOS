-- ============================================================
-- WurxOS v2 — Migration 187: register 'salary' and 'hr' notification
-- categories
--
-- Mig 027 set the default jsonb on profiles.notification_prefs but
-- omitted many categories that later notifications use. The dispatch
-- trigger falls back to push=true via coalesce so unknown categories
-- still deliver, BUT users get no settings toggle for them. Salary
-- Management adds two new categories:
--
--   • 'salary' — employee receives 'salary.updated' when their fixed
--                salary changes
--   • 'hr'     — Boss receives 'anniversary.completed' when an
--                employee reaches a work anniversary
--
-- This migration extends the default + backfills existing profiles
-- so NotificationPrefsSection's new toggles read/write correctly.
-- ============================================================

alter table public.profiles
  alter column notification_prefs set default
    jsonb_build_object(
      'task',        jsonb_build_object('push', true),
      'report',      jsonb_build_object('push', true),
      'brand',       jsonb_build_object('push', true),
      'leave',       jsonb_build_object('push', true),
      'paid_collab', jsonb_build_object('push', true),
      'system',      jsonb_build_object('push', true),
      'salary',      jsonb_build_object('push', true),
      'hr',          jsonb_build_object('push', true)
    );

-- Backfill: any existing row that doesn't have 'salary' or 'hr' keys
-- gets push=true defaults so the toggle UI reflects reality.
update public.profiles
   set notification_prefs = notification_prefs
                          || jsonb_build_object('salary', jsonb_build_object('push', true))
 where not (notification_prefs ? 'salary');

update public.profiles
   set notification_prefs = notification_prefs
                          || jsonb_build_object('hr', jsonb_build_object('push', true))
 where not (notification_prefs ? 'hr');
