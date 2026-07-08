-- ============================================================
-- WurxOS v2 — Migration 234: OL can reopen an APC's presentation.
--
-- Ops need (2026-07-08): after an APC is marked Presented ('done'), the OL
-- may want to let them present AGAIN. This RPC flips that APC's presentation
-- back to 'pending' so agenda_start_presenting (which rejects 'done', mig 180)
-- lets them start over, and the APC's own screen shows them as NOT presented.
--
--   * OL/Boss only; meeting must be ongoing or paused.
--   * Resets status → 'pending' and clears started_at/ended_at.
--   * NON-DESTRUCTIVE: any prior overall rating/summary and per-task reviews
--     are kept (the OL can amend them on the re-run).
--   * Notifies the APC so they know to present again.
--
-- (Giving remarks on an already-presented APC WITHOUT reopening needs no DB
-- change — agenda_task_reviews / agenda_presentations writes are already
-- OL/Boss RLS-gated regardless of presentation status; that's purely a UI
-- affordance.)
--
-- Idempotent.
-- ============================================================

create or replace function public.agenda_reopen_presentation(p_meeting uuid, p_apc uuid)
returns public.agenda_presentations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_m   public.agenda_meetings;
  v_row public.agenda_presentations;
begin
  if not public._agenda_is_ol(v_uid) then
    raise exception 'only OL/Boss can reopen a presentation';
  end if;

  select * into v_m from public.agenda_meetings where id = p_meeting;
  if not found then raise exception 'meeting not found'; end if;
  if v_m.status not in ('ongoing', 'paused') then
    raise exception 'can only reopen a presentation while the meeting is ongoing';
  end if;

  -- Only a completed presentation can be reopened. Keep the reviews.
  update public.agenda_presentations
     set status = 'pending', started_at = null, ended_at = null, updated_at = now()
   where meeting_id = p_meeting and apc_id = p_apc and status = 'done'
   returning * into v_row;
  if not found then
    raise exception 'no completed presentation to reopen for this APC';
  end if;

  perform public.emit_notification(
    p_apc, v_uid, 'agenda', 'agenda.presentation_reopened',
    'Your presentation was reopened',
    'The OL reopened your session — you can present again.',
    'agenda_meeting', p_meeting, '/agenda/ongoing');

  return v_row;
end;
$$;
grant execute on function public.agenda_reopen_presentation(uuid, uuid) to authenticated;
