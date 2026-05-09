-- ============================================================
-- WurxOS v2 — Migration 084: diagnostics for recurring task reset
--
-- Adds a temporary read-only RPC that returns:
--   * Whether the cron job 'reset-recurring-tasks' is scheduled
--   * Recent runs from cron.job_run_details (if accessible)
--   * Sample of recurring tasks with status='done' and their
--     next_reset_at vs now() (so we can see why they're not resetting)
--
-- Boss-only. Returns a JSON blob to keep the result shape flexible.
-- Drop this RPC with a follow-up migration once the issue is debugged.
-- ============================================================

create or replace function public.debug_recurring_reset()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_caller_role text;
  v_cron_job jsonb;
  v_recent_runs jsonb;
  v_done_tasks jsonb;
  v_pg_cron_enabled boolean;
begin
  select role into v_caller_role from public.profiles where id = auth.uid();
  if v_caller_role <> 'boss' then
    raise exception 'Forbidden — Boss only' using errcode = '42501';
  end if;

  select exists(select 1 from pg_extension where extname = 'pg_cron') into v_pg_cron_enabled;

  if v_pg_cron_enabled then
    -- Job definition
    select to_jsonb(j) into v_cron_job
      from cron.job j
     where j.jobname = 'reset-recurring-tasks';

    -- Last 5 run records
    begin
      select jsonb_agg(to_jsonb(r) order by r.start_time desc) into v_recent_runs
        from (
          select start_time, end_time, status, return_message
            from cron.job_run_details
           where jobid = (select jobid from cron.job where jobname = 'reset-recurring-tasks')
           order by start_time desc
           limit 5
        ) r;
    exception when others then
      v_recent_runs := jsonb_build_object('error', SQLERRM);
    end;
  end if;

  -- Sample recurring done tasks: who they belong to and whether
  -- their reset window has passed.
  select jsonb_agg(jsonb_build_object(
    'id', t.id,
    'title', t.title,
    'category', t.category,
    'status', t.status,
    'assignee_role', p.role,
    'assignee_name', p.display_name,
    'next_reset_at', t.next_reset_at,
    'now', now(),
    'is_eligible_to_reset', (
      t.category in ('daily','weekly','monthly')
      and t.status = 'done'
      and t.next_reset_at is not null
      and t.next_reset_at <= now()
    )
  )) into v_done_tasks
  from public.tasks t
  left join public.profiles p on p.id = t.assignee_id
  where t.category in ('daily','weekly','monthly')
    and t.status = 'done'
  order by t.updated_at desc
  limit 20;

  return jsonb_build_object(
    'pg_cron_enabled', v_pg_cron_enabled,
    'job', v_cron_job,
    'recent_runs', v_recent_runs,
    'done_tasks_sample', coalesce(v_done_tasks, '[]'::jsonb),
    'now', now()
  );
end;
$$;

revoke all on function public.debug_recurring_reset() from public;
grant execute on function public.debug_recurring_reset() to authenticated;
