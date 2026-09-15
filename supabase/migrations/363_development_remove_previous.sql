-- ============================================================
-- WurxOS v2 — Migration 363: remove the previous Development workspace.
--
-- The owner asked for Development to be rebuilt from scratch (2026-09-16).
-- Migration 364 creates the new workspace; this one removes every object that
-- migrations 328, 329, 361 and 362 created, in dependency order, so 364 starts
-- from nothing. Nothing outside Development reads these objects: no edge
-- function, no other SQL function, no other page.
--
-- Data: the Development rows on both databases were dummy data and were
-- wiped with the owner's approval on 2026-09-15; the owner confirmed again on
-- 2026-09-16 that nothing in the old workspace needs keeping.
--
-- Deliberately NOT touched:
--   * the `developer` role, which is used across the app;
--   * the Bug Reports feature (bug_reports, /bugs), a separate system;
--   * the empty `dev-issue-screenshots` storage bucket: Supabase blocks deleting
--     storage rows with SQL (protect_buckets_delete). Its access rules go; the
--     empty bucket can be removed from the dashboard.
--
-- No `cascade` anywhere: an unexpected dependent should stop this migration,
-- not be dropped silently along with it.
-- ============================================================

-- 1. Storage access rules for the old screenshot bucket.
drop policy if exists dev_issue_screenshot_insert on storage.objects;
drop policy if exists dev_issue_screenshot_select on storage.objects;

-- 2. The trigger the old workspace put on profiles (profiles itself stays).
drop trigger if exists profiles_sync_dev_team on public.profiles;

-- 3. The progress view reads the tables below.
drop view if exists public.dev_tasks_with_progress;

-- 4. RPCs. Several return a table's row type, which blocks DROP TABLE.
drop function if exists public.dev_ensure_blocks(date);
drop function if exists public.dev_transition_task(uuid, text, text, text);
drop function if exists public.dev_move_feature(uuid, uuid);
drop function if exists public.dev_mark_duplicate(uuid, uuid, text);
drop function if exists public.dev_post_eod(jsonb, text);
drop function if exists public.dev_report_issue(text, text, text);
drop function if exists public.dev_attach_issue_screenshot(uuid, text);
drop function if exists public.dev_rollup_parent(uuid);

-- 5. Tables, children first. Their triggers, policies, indexes and grants go
--    with them.
drop table if exists public.dev_task_notes;
drop table if exists public.dev_subtasks;
drop table if exists public.dev_tasks;
drop table if exists public.dev_blocks;
drop table if exists public.dev_projects;
drop table if exists public.dev_team_members;

-- 6. Trigger functions, now attached to nothing.
drop function if exists public.dev_touch_updated_at();
drop function if exists public.dev_sync_completed_at();
drop function if exists public.dev_subtask_rollup();
drop function if exists public.dev_task_notify();
drop function if exists public.dev_task_v2_notify();
drop function if exists public.dev_guard_feature_update();
drop function if exists public.dev_keep_standing_feature();
drop function if exists public.dev_fill_reviewers();
drop function if exists public.dev_guard_task_update();
drop function if exists public.dev_sync_team_member();

-- 7. Access helpers, last: the dropped policies used them.
drop function if exists public.dev_tasks_can_view(uuid);
drop function if exists public.dev_tasks_can_edit(uuid);

-- 8. Notifications that pointed into the old workspace (none exist today; this
--    keeps a re-run honest).
delete from public.notifications where category = 'dev_task';

-- ── Verify ──────────────────────────────────────────────────────────────
do $v$
declare v text;
begin
  select string_agg(c.relname, ', ') into v
    from pg_class c
   where c.relnamespace = 'public'::regnamespace
     and c.relname in ('dev_tasks', 'dev_subtasks', 'dev_task_notes', 'dev_blocks',
                       'dev_projects', 'dev_team_members', 'dev_tasks_with_progress');
  if v is not null then raise exception '363: still present: %', v; end if;

  select string_agg(p.proname, ', ') into v
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('dev_ensure_blocks', 'dev_transition_task', 'dev_move_feature',
                       'dev_mark_duplicate', 'dev_post_eod', 'dev_report_issue',
                       'dev_attach_issue_screenshot', 'dev_rollup_parent', 'dev_touch_updated_at',
                       'dev_sync_completed_at', 'dev_subtask_rollup', 'dev_task_notify',
                       'dev_task_v2_notify', 'dev_guard_feature_update', 'dev_keep_standing_feature',
                       'dev_fill_reviewers', 'dev_guard_task_update', 'dev_sync_team_member',
                       'dev_tasks_can_view', 'dev_tasks_can_edit');
  if v is not null then raise exception '363: functions still present: %', v; end if;

  if exists (select 1 from pg_trigger where tgname = 'profiles_sync_dev_team') then
    raise exception '363: profiles_sync_dev_team still present';
  end if;

  raise notice '363: previous Development workspace removed';
end;
$v$;
