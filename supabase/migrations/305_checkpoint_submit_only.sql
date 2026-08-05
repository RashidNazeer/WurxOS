-- ============================================================
-- WurxOS v2 — Migration 305: weekly checkpoint becomes submit-only (perf #3).
--
-- Boss-confirmed 2026-08-05: the weekly checkpoint (internal report) has NO TL
-- verification anymore. The APC simply creates and submits; the TL and OL can
-- VIEW it, but there is no verify / return / reopen. The checkpoint no longer
-- feeds performance in any way (the OL's weekly slider is the only checkpoint-
-- related performance input; see mig 304). The checkpoint-return APC dock is
-- retired with the return step.
--
-- Client side (no DB dependency): the Verify / Return / Reopen buttons and the
-- checkpoint deduction prompt are removed; the author can edit their own
-- checkpoint even after submitting (nothing locks it now).
--
-- DB change here is minimal: the status-notification trigger drops the verify and
-- return branches (those transitions no longer happen) and rewords the submit
-- notice from "…for verification" to a plain "submitted a checkpoint you can view".
-- The CHECK constraint stays permissive; log_checkpoint_return + checkpoint_returns
-- remain for historical rows but no new returns are produced. Safe to re-run.
-- ============================================================

create or replace function public.checkpoint_notify_on_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor      uuid := auth.uid();
  v_actor_name text;
  v_brand_name text;
  v_owner      uuid;
  v_wk         text;
  v_link       text;
begin
  if old.status is not distinct from new.status then
    return new;
  end if;

  -- APC submits (draft → submitted) → let the brand owner (TL) know it's ready to view.
  if old.status = 'draft' and new.status = 'submitted' then
    select brand_name, owner_id into v_brand_name, v_owner
      from public.brands where id = new.brand_id;
    if v_owner is not null then
      v_actor_name := coalesce(public.profile_display_name(v_actor), 'Someone');
      v_wk   := coalesce(new.week_label, to_char(new.week_start, 'YYYY-MM-DD'));
      v_link := '/agenda/checkpoint?brand=' || new.brand_id || '&week=' || to_char(new.week_start, 'YYYY-MM-DD');
      perform public.emit_notification(
        v_owner, v_actor, 'agenda', 'checkpoint.submitted',
        'Checkpoint submitted',
        v_actor_name || ' submitted the weekly checkpoint for ' || v_brand_name || ' (' || v_wk || ') — available to view',
        'checkpoint', new.id, v_link);
    end if;
  end if;

  return new;
end;
$$;
