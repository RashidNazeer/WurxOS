-- ============================================================
-- WurxOS v2 — Migration 307: OL can mark an APC as presented after the fact.
--
-- Ops need (2026-08-06): some APCs forget to click "Present" in the live
-- meeting (or were marked absent), so they never get an agenda_presentations
-- row. EVERY rating surface — the live weekly-rating panel, the Performance
-- "pending ratings" list, and the weekly breakdown modal — is gated on that
-- row existing, so once the meeting has passed the OL has no way to score
-- that APC's week.
--
-- This RPC lets the OL/Boss mark such an APC as presented for a past (or
-- ongoing/paused) meeting, creating the 'done' presentation row. It is a
-- RECORD fix ONLY — it does NOT touch any performance/salary math. The
-- weekly rating that actually feeds the composite is still written through
-- the existing audited saveWeeklyRating path (weekly_performance_ratings +
-- wpr_recompute_month rollup); nothing here reads or writes a score. Once
-- the presentation row exists the APC shows up in every rating surface as
-- expected.
--
--   * OL/Boss only (public._agenda_is_ol — boss or active ol/developer).
--   * Meeting must have started (ongoing / paused / completed), never upcoming.
--   * Target must be an APC.
--   * Idempotent + NON-DESTRUCTIVE: a 'pending' row (or no row) becomes 'done';
--     an existing 'presenting'/'done' row is left exactly as-is, so any prior
--     review/summary is never disturbed. started_at/ended_at stay null so the
--     retroactive mark doesn't fake a slot in the presentation timeline.
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
  if v_m.status not in ('ongoing', 'paused', 'completed') then
    raise exception 'can only mark presented for a meeting that has started';
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
grant execute on function public.agenda_mark_presented(uuid, uuid) to authenticated;
