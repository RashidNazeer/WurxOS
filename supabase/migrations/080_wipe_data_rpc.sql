-- ============================================================
-- WurxOS v2 — Migration 080: wipe_all_operational_data RPC
--
-- Boss-only nuclear button. TRUNCATEs every operational table —
-- brands, tasks, reports, resources, campaigns, broadcasts, chat,
-- attendance, etc. — leaving the system in a fresh-install state
-- but PRESERVING:
--   * profiles            (user accounts — so Boss can still log in)
--   * push_subscriptions  (per-device push registrations)
--   * audit_log           (the wipe itself is logged here)
--   * app_config / bi_weekly_anchors / performance_config
--                         (system configuration set by Boss)
--
-- TRUNCATE ... CASCADE handles all FK chains automatically.
-- The function is SECURITY DEFINER so it can bypass RLS, but
-- explicitly checks the caller is an active Boss before running.
-- ============================================================

create or replace function public.wipe_all_operational_data()
returns table(table_name text, rows_before bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller_role text;
  v_caller_active boolean;
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select role, is_active into v_caller_role, v_caller_active
    from public.profiles where id = v_actor;

  if v_caller_role is distinct from 'boss' or v_caller_active is not true then
    raise exception 'Forbidden — Boss only' using errcode = '42501';
  end if;

  -- Snapshot row counts BEFORE wiping so we can return a summary.
  return query
    select 'brands'::text, count(*) from public.brands union all
    select 'tasks',          count(*) from public.tasks union all
    select 'reports',        count(*) from public.reports union all
    select 'resources',      count(*) from public.resources union all
    select 'campaigns',      count(*) from public.campaigns union all
    select 'product_campaigns', count(*) from public.product_campaigns union all
    select 'broadcasts',     count(*) from public.broadcasts union all
    select 'attendance',     count(*) from public.attendance union all
    select 'leave_requests', count(*) from public.leave_requests union all
    select 'incentives',     count(*) from public.incentives union all
    select 'chat_channels',  count(*) from public.chat_channels union all
    select 'chat_messages',  count(*) from public.chat_messages union all
    select 'notifications',  count(*) from public.notifications union all
    select 'bug_reports',    count(*) from public.bug_reports union all
    select 'suggestions',    count(*) from public.suggestions union all
    select 'changes',        count(*) from public.changes union all
    select 'kb_articles',    count(*) from public.kb_articles union all
    select 'reminders',      count(*) from public.reminders;

  -- TRUNCATE everything operational. CASCADE follows FK chains so
  -- we don't need to list children separately, but we list the
  -- aggregate-root tables for clarity.
  truncate table
    public.brands,
    public.tasks,
    public.reports,
    public.resources,
    public.campaigns,
    public.product_campaigns,
    public.broadcasts,
    public.attendance,
    public.attendance_edit_requests,
    public.leave_requests,
    public.incentives,
    public.chat_channels,
    public.chat_messages,
    public.chat_members,
    public.notifications,
    public.bug_reports,
    public.bug_report_messages,
    public.suggestions,
    public.suggestion_upvotes,
    public.changes,
    public.change_thread,
    public.kb_articles,
    public.kb_acknowledgments,
    public.kb_comments,
    public.reminders,
    public.brand_switch_requests,
    public.pctl_brand_selections,
    public.performance_ratings,
    public.performance_warnings,
    public.performance_flags,
    public.user_report_custom_fields,
    public.report_shares,
    public.tier_notification_log,
    public.campaign_notification_log,
    public.task_comments,
    public.task_attachments,
    public.brand_assignments,
    public.brand_metrics,
    public.brand_custom_fields,
    public.brand_products,
    public.broadcast_responses,
    public.resource_planner_config
  cascade;

  -- Audit the wipe so there's a permanent forensic record.
  insert into public.audit_log (actor_id, action, target_type, target_id, payload)
  values (
    v_actor,
    'admin.wipe_all_data',
    'system',
    null,
    jsonb_build_object('at', now())
  );
end;
$$;

revoke all on function public.wipe_all_operational_data() from public;
grant execute on function public.wipe_all_operational_data() to authenticated;

comment on function public.wipe_all_operational_data() is
  'Boss-only. TRUNCATEs all operational tables (brands, tasks, reports, etc.). Keeps profiles, push subscriptions, audit log, and system config. Returns a summary of rows that existed before the wipe.';
