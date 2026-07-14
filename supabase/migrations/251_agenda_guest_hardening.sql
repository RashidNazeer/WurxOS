-- ============================================================
-- WurxOS v2 — Migration 251: five defects in the guest-teams feature,
-- found by adversarial review of 249/250 before anyone used it.
--
-- (1) REOPEN RE-INVITED EVERY GUEST — the worst of them.
--     249 preserved the Prior archive by stamping {paid_collab,paid_media}
--     into guest_teams on all 20 pre-existing completed meetings. But
--     guest_teams is not archive-only: agenda_start_meeting accepts
--     'completed' (mig 198 — reopening a meeting is a real, wired OL action).
--     Reopening ANY meeting from before this feature would therefore flip it
--     live still carrying both guest slugs — notifying every PCTL, every IPC
--     and Subhan to "join now", and admitting them to the room, the
--     attendance and the reviews of a team that never invited them. The exact
--     thing this feature exists to prevent.
--
--     Archive visibility and a live invite are two different rights, so they
--     now get two different columns. legacy_guest_visible re-opens the OLD
--     archive to guests and NOTHING else: it is read-only by construction,
--     because the policy branch requires status = 'completed'. Reopen such a
--     meeting and it has no guests at all — which is correct, since nobody
--     was ever invited to it.
--
-- (2) RESYNC REVERTED PER-WEEK OVERRIDES.
--     agenda_resync_week looped EVERY schedule, so "Apply to this week too"
--     after editing one team's TIME silently reverted an unrelated team's
--     guest override — and re-invited the people the OL had just removed. It
--     now takes the teams that actually changed.
--
-- (3) _agenda_guest_members was anon-callable. It is SECURITY DEFINER and
--     returns profile UUIDs, so the public anon key could enumerate staff.
--     Postgres grants EXECUTE to PUBLIC by default; revoke it.
--
-- (4) Joining a guest team mid-week granted access with no notification —
--     "they find out by going and looking", which is what 249 set out to fix.
--     Adding a member now goes through an RPC that tells them what they just
--     got invited to.
--
-- Idempotent.
-- ============================================================

-- 1. Archive access ≠ live invite -----------------------------------------
alter table public.agenda_meetings
  add column if not exists legacy_guest_visible boolean not null default false;

-- Move the 249 backfill out of guest_teams. Safe to match on the exact pair:
-- no real invite exists yet (every schedule still has guest_teams = '{}'), so
-- these rows can only be the ones 249 stamped.
update public.agenda_meetings
   set legacy_guest_visible = true,
       guest_teams          = '{}'
 where status = 'completed'
   and guest_teams @> array['paid_collab','paid_media']
   and guest_teams <@ array['paid_collab','paid_media'];

create or replace function public.agenda_meeting_visible(p_status text, p_guests text[], p_legacy boolean)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select (p_guests && public.agenda_guest_teams_for(auth.uid()))
      or (p_legacy
          and p_status = 'completed'
          and coalesce(array_length(public.agenda_guest_teams_for(auth.uid()), 1), 0) > 0);
$$;
revoke all on function public.agenda_meeting_visible(text, text[], boolean) from public, anon;
grant execute on function public.agenda_meeting_visible(text, text[], boolean) to authenticated;

drop policy if exists "agenda_meetings_select" on public.agenda_meetings;
create policy "agenda_meetings_select"
  on public.agenda_meetings for select
  using (
    public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p
               where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
    or tl_id = auth.uid()
    or tl_id = (select reports_to from public.profiles where id = auth.uid())
    or public.agenda_meeting_visible(status, guest_teams, legacy_guest_visible)
  );

create or replace function public.agenda_can_view_meeting(p_meeting uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.agenda_meetings m
    where m.id = p_meeting and (
      public.is_boss(auth.uid())
      or exists (select 1 from public.profiles p
                 where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
      or m.tl_id = auth.uid()
      or m.tl_id = (select reports_to from public.profiles where id = auth.uid())
      or public.agenda_meeting_visible(m.status, m.guest_teams, m.legacy_guest_visible)
    )
  );
$$;
grant execute on function public.agenda_can_view_meeting(uuid) to authenticated;

drop policy if exists "agenda_rev_select" on public.agenda_task_reviews;
create policy "agenda_rev_select"
  on public.agenda_task_reviews for select
  using (
    public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p
               where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
    or apc_id = auth.uid()
    or exists (select 1 from public.agenda_meetings m
               where m.id = meeting_id
                 and (m.tl_id = auth.uid()
                      or public.agenda_meeting_visible(m.status, m.guest_teams, m.legacy_guest_visible)))
  );

-- 2. Anon could enumerate staff UUIDs through a SECURITY DEFINER function ---
revoke all on function public._agenda_guest_members(text[]) from public, anon;
revoke all on function public.agenda_guest_teams_for(uuid) from public, anon;
grant execute on function public.agenda_guest_teams_for(uuid) to authenticated;

-- 3. Resync only the teams whose schedule actually changed ------------------
drop function if exists public.agenda_resync_week(date);
create or replace function public.agenda_resync_week(p_week_start date, p_tl_ids uuid[] default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_sched   record;
  v_m       record;
  v_date    date;
  v_count   int := 0;
  v_guest   record;
  v_label   text;
  v_tl_name text;
begin
  if not public._agenda_is_ol(v_uid) then
    raise exception 'only OL/Boss can update meeting schedules';
  end if;

  for v_sched in
    select s.* from public.agenda_team_schedules s
    join public.profiles p on p.id = s.tl_id
    where p.is_active = true and p.deleted_at is null
      -- null = every team (the old behaviour). A list = only what the OL
      -- edited, so an unrelated team's per-week guest override survives.
      and (p_tl_ids is null or s.tl_id = any(p_tl_ids))
  loop
    v_date := p_week_start + public._agenda_day_offset(v_sched.meeting_day);

    select id, guest_teams into v_m
      from public.agenda_meetings
     where tl_id = v_sched.tl_id and week_start = p_week_start and status = 'upcoming';
    if not found then
      continue;
    end if;

    update public.agenda_meetings
       set meeting_date = v_date,
           meeting_time = v_sched.meeting_time,
           guest_teams  = v_sched.guest_teams,
           updated_at   = now()
     where id = v_m.id;
    v_count := v_count + 1;

    if v_sched.guest_teams is distinct from v_m.guest_teams then
      v_label := to_char(v_date, 'FMDay, FMDD FMMon') || ' at ' || to_char(v_sched.meeting_time, 'FMHH12:MI AM');
      select display_name into v_tl_name from public.profiles where id = v_sched.tl_id;

      for v_guest in
        select gm.user_id, gm.labels
          from public._agenda_guest_members(v_sched.guest_teams) gm
          join public.profiles p on p.id = gm.user_id
         where gm.user_id <> v_sched.tl_id
           and p.reports_to is distinct from v_sched.tl_id
           and gm.user_id not in (
             select user_id from public._agenda_guest_members(coalesce(v_m.guest_teams, '{}')))
      loop
        perform public.emit_notification(
          v_guest.user_id, v_uid, 'agenda', 'agenda.meeting_scheduled',
          coalesce(v_tl_name, 'Team') || '''s agenda meeting',
          'You''re attending as ' || v_guest.labels || ' — ' || v_label || '.',
          'agenda_meeting', v_m.id, '/agenda/upcoming');
      end loop;
    end if;
  end loop;

  return jsonb_build_object('updated', v_count);
end;
$$;
grant execute on function public.agenda_resync_week(date, uuid[]) to authenticated;

-- 4. Joining a guest team tells you what you just joined --------------------
create or replace function public.agenda_add_guest_member(p_slug text, p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_label text;
  v_m     record;
begin
  if not public._agenda_is_ol(v_uid) then
    raise exception 'only OL/Boss can change guest teams';
  end if;

  select label into v_label from public.agenda_guest_teams where slug = p_slug;
  if v_label is null then
    raise exception 'unknown guest team %', p_slug;
  end if;

  insert into public.agenda_guest_team_members (team_slug, user_id, added_by)
  values (p_slug, p_user, v_uid)
  on conflict (team_slug, user_id) do nothing;
  if not found then
    return;   -- already a member; they've already been told
  end if;

  -- Everything this membership just let them into, so they don't have to go
  -- looking for it. Their own team's meeting is not news to them.
  for v_m in
    select m.id, m.meeting_date, m.meeting_time, p.display_name as tl_name
      from public.agenda_meetings m
      join public.profiles p on p.id = m.tl_id
     where m.status in ('upcoming','ongoing','paused')
       and p_slug = any(m.guest_teams)
       and m.tl_id <> p_user
       and m.tl_id is distinct from (select reports_to from public.profiles where id = p_user)
  loop
    perform public.emit_notification(
      p_user, v_uid, 'agenda', 'agenda.meeting_scheduled',
      coalesce(v_m.tl_name, 'Team') || '''s agenda meeting',
      'You''re attending as ' || v_label || ' — '
        || to_char(v_m.meeting_date, 'FMDay, FMDD FMMon')
        || ' at ' || to_char(v_m.meeting_time, 'FMHH12:MI AM') || '.',
      'agenda_meeting', v_m.id, '/agenda/upcoming');
  end loop;
end;
$$;
grant execute on function public.agenda_add_guest_member(text, uuid) to authenticated;
