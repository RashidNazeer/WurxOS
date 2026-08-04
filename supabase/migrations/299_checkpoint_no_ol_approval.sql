-- ============================================================
-- 299 — Weekly Checkpoint: remove the OL approval step (APC ↔ TL only).
--
-- The flow was  draft → submitted → TL verify → OL approve (terminal).
-- Boss-confirmed: the checkpoint is strictly between the APC and their TL — no
-- Operation Lead in the loop. So **TL 'verify' becomes the terminal DONE state**
-- and the 'approved' stage is retired.
--
-- What this migration does:
--  1. Migrates existing terminal 'approved' rows to the new terminal 'verified'.
--  2. Rewrites the status-notification trigger: drop the OL notifications; a TL
--     verify now notifies the APC author ("Checkpoint verified").
--  3. Rewrites the return-log trigger: the only real "return" now is
--     submitted → draft (TL → APC); verified → submitted is the TL's own reopen.
--
-- Client side (no DB dependency): approveCheckpoint removed; reopen moves
-- verified → submitted; the Approve button/pill/labels are gone. Nothing
-- downstream keys off 'approved' — the PDF, §09 paid-collab fetch and the
-- reporting-deduction chain all hang off the TL→APC return event, which stays.
--
-- The CHECK constraint still ALLOWS 'approved' (no tightening) so a stale client
-- can't hit a constraint error; no code writes it anymore. Safe to re-run.
-- ============================================================

-- 1. Existing terminal 'approved' rows → the new terminal 'verified'.
update public.weekly_checkpoints
   set status = 'verified', approved_at = null, approved_by = null
 where status = 'approved';

-- 2. Notifications — no OL; TL verify (DONE) pings the APC author.
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

  select brand_name, owner_id into v_brand_name, v_owner
    from public.brands where id = new.brand_id;

  v_actor_name := coalesce(public.profile_display_name(v_actor), 'Someone');
  v_wk   := coalesce(new.week_label, to_char(new.week_start, 'YYYY-MM-DD'));
  v_link := '/agenda/checkpoint?brand=' || new.brand_id || '&week=' || to_char(new.week_start, 'YYYY-MM-DD');

  -- APC submits (draft → submitted) → notify brand owner (TL).
  if old.status = 'draft' and new.status = 'submitted' and v_owner is not null then
    perform public.emit_notification(
      v_owner, v_actor, 'agenda', 'checkpoint.submitted',
      'Checkpoint submitted for verification',
      v_actor_name || ' submitted the weekly checkpoint for ' || v_brand_name || ' (' || v_wk || ')',
      'checkpoint', new.id, v_link);
  end if;

  -- TL verifies (submitted → verified) = DONE → notify the APC author.
  if old.status = 'submitted' and new.status = 'verified' and new.author_id is not null then
    perform public.emit_notification(
      new.author_id, v_actor, 'agenda', 'checkpoint.verified',
      'Checkpoint verified',
      v_actor_name || ' verified your weekly checkpoint for ' || v_brand_name || ' (' || v_wk || ')',
      'checkpoint', new.id, v_link);
  end if;

  -- TL returns to APC (submitted → draft) → notify the APC author.
  if old.status = 'submitted' and new.status = 'draft' and new.author_id is not null then
    perform public.emit_notification(
      new.author_id, v_actor, 'agenda', 'checkpoint.returned',
      'Checkpoint returned for revision',
      v_actor_name || ' sent back the weekly checkpoint for ' || v_brand_name
        || case when coalesce(new.return_note,'') <> '' then ' — note: ' || new.return_note else '' end,
      'checkpoint', new.id, v_link);
  end if;

  return new;
end;
$$;

-- 3. Return log — only submitted → draft is a real return now.
create or replace function public.log_checkpoint_return()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status = 'submitted' and new.status = 'draft' then
    insert into public.checkpoint_returns (checkpoint_id, returned_by, returned_at, from_status, to_status, note)
    values (
      new.id,
      coalesce(new.returned_by, auth.uid()),
      coalesce(new.returned_at, now()),
      old.status,
      new.status,
      new.return_note
    );
  end if;
  return new;
end;
$$;
