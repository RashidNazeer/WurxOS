-- ============================================================
-- WurxOS v2 — Migration 082: fix audit_log column names in wipe RPC
--
-- The RPC from migration 081 tried to insert into audit_log with
-- columns (target_type, target_id, payload) — but the actual schema
-- (migration 028) uses (entity_type, entity_id, before, after) and
-- restricts `action` via CHECK to ('insert','update','delete').
--
-- This migration drops and recreates the function with the correct
-- column names and a valid action ('delete', semantically accurate
-- for a wipe). The function body is otherwise identical.
-- ============================================================

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

  foreach v_table in array v_all loop
    if to_regclass(v_table) is not null then
      v_existing := v_existing || v_table;
    end if;
  end loop;

  foreach v_table in array v_existing loop
    execute format('select count(*) from %s', v_table) into v_count;
    table_name := split_part(v_table, '.', 2);
    rows_before := v_count;
    caller_id := v_actor;
    return next;
  end loop;

  if array_length(v_existing, 1) > 0 then
    execute format(
      'truncate table %s cascade',
      array_to_string(v_existing, ', ')
    );
  end if;

  -- Forensic record of the wipe. audit_log uses entity_type/entity_id
  -- (not target_*), and the action column has a CHECK constraint
  -- limiting it to insert/update/delete — 'delete' is the right
  -- semantic here. The wiped table list is stored in `before` jsonb.
  if to_regclass('public.audit_log') is not null then
    insert into public.audit_log (actor_id, entity_type, entity_id, action, before, after)
    values (
      v_actor,
      'system_wipe',
      null,
      'delete',
      jsonb_build_object('at', now(), 'tables_wiped', v_existing),
      null
    );
  end if;
end;
$$;

revoke all on function public.wipe_all_operational_data() from public;
grant execute on function public.wipe_all_operational_data() to authenticated;
