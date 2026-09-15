-- ============================================================
-- WurxOS v2 — Migration 362: Development activity log, and anon hygiene.
--
-- 1. The v2 spec (§02) says a task's activity log records EVERY status change
--    with who and when. Planning moved a feature's Backlog tasks to Planned in
--    bulk without writing any entry, so the task card could never show
--    "Usman scheduled into 15–28 Sep". dev_move_feature is replaced with its
--    latest definition (migration 361, the only other one) plus that entry.
--    Nothing else about planning changes. dev_task_notes has no triggers, so
--    the extra rows notify nobody.
--
-- 2. Supabase grants anon EXECUTE on every new function, and revoking from
--    public alone does not undo that. 361 never revoked it. Each of these
--    functions already refuses a caller without a session, so this closes a
--    door that was locked rather than open. authenticated keeps the explicit
--    grants from 361.
--
-- Applied to DEV first. PROD needs 361 before this one.
-- ============================================================

create or replace function public.dev_move_feature(p_feature uuid, p_block uuid)
returns public.dev_tasks
language plpgsql security definer set search_path = public as $fn$
declare
  v public.dev_tasks;
  v_missing int;
  v_block public.dev_blocks;
  v_label text;
begin
  if not public.is_boss(auth.uid()) then raise exception 'only the Boss plans blocks'; end if;
  if p_block is not null then
    select count(*) into v_missing from public.dev_subtasks
     where task_id = p_feature and coalesce(trim(acceptance_check), '') = '';
    if v_missing > 0 then raise exception 'Add an acceptance check before scheduling'; end if;
    select * into v_block from public.dev_blocks where id = p_block;
    if not found then raise exception 'block not found'; end if;
    -- "into 15–28 Sep", or "into 29 Sep – 12 Oct" across a month boundary.
    v_label := 'into ' || case
      when date_trunc('month', v_block.starts_on) = date_trunc('month', v_block.ends_on)
        then to_char(v_block.starts_on, 'FMDD') || '–' || to_char(v_block.ends_on, 'FMDD Mon')
      else to_char(v_block.starts_on, 'FMDD Mon') || ' – ' || to_char(v_block.ends_on, 'FMDD Mon')
    end;
  end if;
  perform set_config('app.dev_planning', 'allowed', true);
  update public.dev_tasks
     set block_id = p_block,
         planned_task_count = case when p_block is null then null
           else (select count(*) from public.dev_subtasks where task_id = p_feature) end
   where id = p_feature returning * into v;
  if not found then raise exception 'feature not found'; end if;
  if p_block is not null then
    perform set_config('app.dev_transition', 'allowed', true);
    with moved as (
      update public.dev_subtasks set status = 'planned'
       where task_id = p_feature and status = 'backlog'
      returning id, task_id
    )
    insert into public.dev_task_notes(task_id, subtask_id, author_id, status_from, status_to, body)
    select moved.task_id, moved.id, auth.uid(), 'backlog', 'planned', v_label
      from moved;
  end if;
  return v;
end;
$fn$;

revoke execute on function public.dev_ensure_blocks(date) from public, anon;
revoke execute on function public.dev_transition_task(uuid, text, text, text) from public, anon;
revoke execute on function public.dev_move_feature(uuid, uuid) from public, anon;
revoke execute on function public.dev_mark_duplicate(uuid, uuid, text) from public, anon;
revoke execute on function public.dev_post_eod(jsonb, text) from public, anon;
revoke execute on function public.dev_report_issue(text, text, text) from public, anon;
revoke execute on function public.dev_attach_issue_screenshot(uuid, text) from public, anon;

grant execute on function public.dev_move_feature(uuid, uuid) to authenticated;
