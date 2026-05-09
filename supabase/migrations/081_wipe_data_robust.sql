-- ============================================================
-- WurxOS v2 — Migration 081: defensive wipe + caller-id return
--
-- Replaces the RPC from migration 080 with a robust version that:
--   1. Skips tables that don't exist in this database (avoids the
--      "relation public.report_shares does not exist" error when
--      the schema drifts from what the RPC was written against).
--   2. Returns the caller's UUID alongside the per-table summary
--      so the delete-data Edge Function knows which auth.users
--      row to keep (everyone else gets hard-deleted from auth).
--
-- Tables to wipe are listed once at the top; iterating with
-- to_regclass() makes the RPC self-healing as new tables are added
-- or old ones renamed.
-- ============================================================

-- DROP first because Postgres won't let CREATE OR REPLACE change a
-- function's return type (we're adding caller_id to the result).
drop function if exists public.wipe_all_operational_data();

create or replace function public.wipe_all_operational_data()
returns table(table_name text, rows_before bigint, caller_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller_role text;
  v_caller_active boolean;
  v_actor uuid := auth.uid();
  v_table text;
  v_count bigint;
  v_existing text[] := array[]::text[];
  v_all text[] := array[
    -- Aggregate roots — CASCADE handles their children
    'public.brands',
    'public.tasks',
    'public.reports',
    'public.resources',
    'public.campaigns',
    'public.product_campaigns',
    'public.broadcasts',
    'public.attendance',
    'public.attendance_edit_requests',
    'public.leave_requests',
    'public.incentives',
    'public.chat_channels',
    'public.chat_messages',
    'public.chat_members',
    'public.notifications',
    'public.bug_reports',
    'public.bug_report_messages',
    'public.suggestions',
    'public.suggestion_upvotes',
    'public.changes',
    'public.change_thread',
    'public.kb_articles',
    'public.kb_acknowledgments',
    'public.kb_comments',
    'public.reminders',
    'public.brand_switch_requests',
    'public.pctl_brand_selections',
    'public.performance_ratings',
    'public.performance_warnings',
    'public.performance_flags',
    'public.user_report_custom_fields',
    'public.report_shares',
    'public.tier_notification_log',
    'public.campaign_notification_log',
    'public.task_comments',
    'public.task_attachments',
    'public.brand_assignments',
    'public.brand_metrics',
    'public.brand_custom_fields',
    'public.brand_products',
    'public.broadcast_responses',
    'public.resource_planner_config'
  ];
begin
  if v_actor is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select role, is_active into v_caller_role, v_caller_active
    from public.profiles where id = v_actor;

  if v_caller_role is distinct from 'boss' or v_caller_active is not true then
    raise exception 'Forbidden — Boss only' using errcode = '42501';
  end if;

  -- Filter to tables that actually exist in this database. Anything
  -- missing (renamed, never created) is silently skipped instead of
  -- crashing the whole wipe.
  foreach v_table in array v_all loop
    if to_regclass(v_table) is not null then
      v_existing := v_existing || v_table;
    end if;
  end loop;

  -- Snapshot row counts before wiping. Build the result rowset by
  -- executing a count for each existing table.
  foreach v_table in array v_existing loop
    execute format('select count(*) from %s', v_table) into v_count;
    table_name := split_part(v_table, '.', 2);
    rows_before := v_count;
    caller_id := v_actor;
    return next;
  end loop;

  -- TRUNCATE everything in one statement so FK chains follow once.
  if array_length(v_existing, 1) > 0 then
    execute format(
      'truncate table %s cascade',
      array_to_string(v_existing, ', ')
    );
  end if;

  -- Forensic record of the wipe (audit_log is preserved).
  if to_regclass('public.audit_log') is not null then
    insert into public.audit_log (actor_id, action, target_type, target_id, payload)
    values (
      v_actor,
      'admin.wipe_all_data',
      'system',
      null,
      jsonb_build_object('at', now(), 'tables_wiped', v_existing)
    );
  end if;
end;
$$;

revoke all on function public.wipe_all_operational_data() from public;
grant execute on function public.wipe_all_operational_data() to authenticated;

comment on function public.wipe_all_operational_data() is
  'Boss-only. Defensively TRUNCATEs all operational tables (skips any that do not exist). Returns one row per table with the count that existed before the wipe, plus the caller UUID so the calling client knows which auth user to spare during user-account deletion.';
