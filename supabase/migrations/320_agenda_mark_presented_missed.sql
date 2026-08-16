-- ============================================================
-- WurxOS v2 — Migration 320: let an OL run the catch-up flow on a MISSED
-- meeting (one that was never started).
--
-- Prior Meetings already lets an OL rate an APC after the fact — the case where
-- someone presented but the OL forgot to click Present (mig 307). What it can't
-- handle is a whole team's meeting that never ran at all: those rows sit at
-- status 'upcoming' forever, never appear in Prior Meetings, and
-- agenda_mark_presented refuses them outright:
--     'can only mark presented for a meeting that has started'
--
-- The OL still needs to score that week — the weekly rating feeds the APC
-- performance blend (mig 269/304), so a missed meeting silently costs the whole
-- team its week rather than recording a real zero or a catch-up score. Ratings
-- themselves were never gated (saveWeeklyRating is a plain upsert), so this one
-- guard was the only thing standing in the way.
--
-- CHANGE: allow 'upcoming' too, but ONLY once the meeting's scheduled date has
-- passed in Asia/Karachi. That keeps the guard's real intent — you still cannot
-- pre-mark a meeting that hasn't happened yet — while letting the OL close out
-- a week that got skipped.
--
-- Body is mig 307's VERBATIM apart from that status condition. Idempotent.
-- ============================================================

create or replace function public.agenda_mark_presented(p_meeting uuid, p_apc uuid)
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
    raise exception 'only OL/Boss can mark an APC as presented';
  end if;

  select * into v_m from public.agenda_meetings where id = p_meeting;
  if not found then raise exception 'meeting not found'; end if;

  -- Started meetings: always fine. Never-started ones: only in the past — a
  -- meeting still to come has nothing to catch up on.
  if v_m.status not in ('ongoing', 'paused', 'completed')
     and not (
       v_m.status = 'upcoming'
       and v_m.meeting_date is not null
       and v_m.meeting_date < (now() at time zone 'Asia/Karachi')::date
     ) then
    raise exception 'can only mark presented for a meeting that has started, or one whose date has passed';
  end if;

  if not exists (select 1 from public.profiles where id = p_apc and role = 'apc') then
    raise exception 'target is not an APC';
  end if;

  -- Create the row (or promote a dangling 'pending' one). Leaving a
  -- 'presenting'/'done' row untouched keeps the record and any reviews intact.
  insert into public.agenda_presentations (meeting_id, apc_id, status)
  values (p_meeting, p_apc, 'done')
  on conflict (meeting_id, apc_id) do update
     set status = 'done', updated_at = now()
   where public.agenda_presentations.status = 'pending';

  select * into v_row from public.agenda_presentations
   where meeting_id = p_meeting and apc_id = p_apc;
  return v_row;
end;
$$;
