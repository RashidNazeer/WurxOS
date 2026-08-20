-- ============================================================
-- WurxOS v2 — Migration 324: a TL or OL can start a presentation ON BEHALF
-- of an APC who forgot to click.
--
-- agenda_start_presenting (mig 180) took no target and always used auth.uid(),
-- requiring the caller to be an APC of that team. So when an APC forgot to hit
-- "Start presenting" — which happens constantly, because they are talking, not
-- looking at the screen — nobody else could start it for them. The meeting ran,
-- the APC presented, and no record existed. That gap is what later forces the
-- OL into the catch-up flow (mig 307/320) and, when a rating gets attached to a
-- meeting with no presentation row, produces the invisible-rating bug fixed
-- alongside this.
--
-- CHANGE: an optional p_apc. Omit it (or pass your own id) and nothing changes
-- — an APC still starts their own. Pass someone else's and the caller must be
-- that meeting's TL, an active OL, or the Boss.
--
-- WHO CLICKED IS RECORDED. started_by is new and set on every start, including
-- self-starts, so "the TL started this for them" is never mistaken for "the APC
-- was there and clicked". Without it, starting on behalf would quietly fabricate
-- attendance evidence.
--
-- The old single-argument signature is KEPT as a wrapper so any caller still on
-- it (and the existing grant) keeps working.
--
-- Idempotent.
-- ============================================================

alter table public.agenda_presentations
  add column if not exists started_by uuid references public.profiles(id) on delete set null;

comment on column public.agenda_presentations.started_by is
  'Who clicked Start. Differs from apc_id when a TL/OL started it on the APC''s behalf (mig 324).';

create or replace function public.agenda_start_presenting(p_meeting uuid, p_apc uuid default null)
returns public.agenda_presentations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_target uuid := coalesce(p_apc, auth.uid());
  v_m      public.agenda_meetings;
  v_row    public.agenda_presentations;
  v_onbehalf boolean := coalesce(p_apc, auth.uid()) is distinct from auth.uid();
begin
  select * into v_m from public.agenda_meetings where id = p_meeting;
  if not found then raise exception 'meeting not found'; end if;
  if v_m.status <> 'ongoing' then raise exception 'meeting is not ongoing'; end if;

  -- The target must always be an APC on THIS team, however it was started.
  -- Checked before the permission branch so "wrong person" reads as a clear
  -- error rather than a permission failure.
  if not exists (
    select 1 from public.profiles p
    where p.id = v_target and p.role = 'apc' and p.reports_to = v_m.tl_id
  ) then
    raise exception 'that person is not an APC of this team';
  end if;

  if v_onbehalf then
    -- Starting for someone else: the team's TL, an active OL, or the Boss.
    if not (
      v_m.tl_id = v_uid
      or public.is_boss(v_uid)
      or exists (select 1 from public.profiles p
                 where p.id = v_uid and p.role in ('ol','developer') and p.is_active = true)
    ) then
      raise exception 'only this team''s Team Lead, an Operations Lead or the Boss can start a presentation for someone else';
    end if;
  end if;

  -- One presentation per APC per meeting — no re-presenting after 'done'.
  -- (An OL can still reopen it explicitly, mig 234.)
  if exists (
    select 1 from public.agenda_presentations
    where meeting_id = p_meeting and apc_id = v_target and status = 'done'
  ) then
    raise exception '% already presented in this meeting',
      case when v_onbehalf then 'that APC' else 'you have' end;
  end if;

  if exists (
    select 1 from public.agenda_presentations
    where meeting_id = p_meeting and status = 'presenting' and apc_id <> v_target
  ) then
    raise exception 'another APC is currently presenting';
  end if;

  insert into public.agenda_presentations (meeting_id, apc_id, status, started_at, started_by)
  values (p_meeting, v_target, 'presenting', now(), v_uid)
  on conflict (meeting_id, apc_id) do update
    set status     = 'presenting',
        started_at = coalesce(public.agenda_presentations.started_at, now()),
        started_by = v_uid,
        ended_at   = null,
        updated_at = now()
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.agenda_start_presenting(uuid, uuid) to authenticated;
