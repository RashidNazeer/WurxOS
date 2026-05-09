-- ============================================================
-- Migration 073 — DMs auto-delete on depart
--
-- The v1 / v2 "Leave conversation" flow deleted only the caller's
-- chat_members row. For group channels that's right (other members
-- keep the group). For a 1-on-1 DM it stranded the other participant
-- in a channel with no one left to name, producing the ghost DM
-- rendered as "Direct message" / "?" avatar.
--
-- Policy change: a DM has no meaning with fewer than 2 members.
-- When any chat_members DELETE drops a DM below 2, we delete the
-- channel outright. Cascades take care of messages + the remaining
-- member row. This turns "Leave" into "Delete chat" for DMs
-- without needing separate frontend plumbing.
--
-- Also:
--   * one-time cleanup of any DMs currently sitting below 2 members
--   * chat_list_my_channels filters orphan DMs defensively
-- ============================================================

-- --------------------------------------------------------------
-- 1. Auto-delete DM trigger
-- --------------------------------------------------------------
-- AFTER DELETE so the member row has already been removed and the
-- remaining-count query reflects post-delete state.
create or replace function public.chat_auto_delete_orphan_dm()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind text;
  v_remaining int;
begin
  select kind into v_kind from public.chat_channels where id = old.channel_id;
  if v_kind is null or v_kind <> 'dm' then
    return old;  -- group channels are unaffected
  end if;

  select count(*) into v_remaining
    from public.chat_members
    where channel_id = old.channel_id;

  if v_remaining < 2 then
    -- Cascade wipes messages + any remaining member row.
    delete from public.chat_channels where id = old.channel_id;
  end if;
  return old;
end;
$$;

drop trigger if exists chat_members_dm_cleanup on public.chat_members;
create trigger chat_members_dm_cleanup
  after delete on public.chat_members
  for each row execute function public.chat_auto_delete_orphan_dm();

-- --------------------------------------------------------------
-- 2. One-time cleanup of existing orphan DMs
--    Any DM with fewer than 2 surviving members is already broken.
-- --------------------------------------------------------------
do $$
declare
  v_ids uuid[];
begin
  select array_agg(c.id) into v_ids
    from public.chat_channels c
    left join public.chat_members cm on cm.channel_id = c.id
    where c.kind = 'dm'
    group by c.id
    having count(cm.user_id) < 2;

  if v_ids is not null and array_length(v_ids, 1) > 0 then
    delete from public.chat_channels where id = any(v_ids);
  end if;
end;
$$;

-- --------------------------------------------------------------
-- 3. Defensive filter in chat_list_my_channels
--    Hide DMs whose other member's profile no longer exists (e.g.
--    a deleted user with a NOT-cascaded chat_members row). The
--    trigger above should prevent this case, but this keeps the
--    UI clean even if something slips through.
-- --------------------------------------------------------------
-- Signature is already defined by migration 042 — keep it identical.
create or replace function public.chat_list_my_channels()
returns table (
  channel_id     uuid,
  kind           text,
  name           text,
  created_at     timestamptz,
  created_by     uuid,
  last_read_at   timestamptz,
  members        jsonb,
  last_message   jsonb,
  unread_count   int
)
language plpgsql
security definer
set search_path = public
stable
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then return; end if;

  return query
  with my_chans as (
    select cm.channel_id, cm.last_read_at
      from public.chat_members cm
     where cm.user_id = v_uid
  ),
  members_agg as (
    select cm.channel_id,
           coalesce(jsonb_agg(jsonb_build_object(
             'id',           p.id,
             'display_name', p.display_name,
             'role',         p.role,
             'avatar_url',   p.avatar_url
           ) order by (p.id = v_uid), p.display_name), '[]'::jsonb) as members,
           count(*)::int as member_count
      from public.chat_members cm
      join public.profiles p on p.id = cm.user_id
     where cm.channel_id in (select channel_id from my_chans)
     group by cm.channel_id
  ),
  last_msg as (
    select distinct on (m.channel_id)
           m.channel_id,
           jsonb_build_object(
             'id',          m.id,
             'body',        m.body,
             'author_id',   m.author_id,
             'author_name', p.display_name,
             'created_at',  m.created_at
           ) as last_message,
           m.created_at as last_at
      from public.chat_messages m
      join public.profiles p on p.id = m.author_id
     where m.channel_id in (select channel_id from my_chans)
     order by m.channel_id, m.created_at desc
  ),
  unread as (
    select m.channel_id, count(*)::int as unread_count
      from public.chat_messages m
      join my_chans mc on mc.channel_id = m.channel_id
     where m.created_at > mc.last_read_at
       and m.author_id <> v_uid
     group by m.channel_id
  )
  select
    c.id          as channel_id,
    c.kind,
    c.name,
    c.created_at,
    c.created_by,
    mc.last_read_at,
    coalesce(ma.members, '[]'::jsonb)         as members,
    lm.last_message,
    coalesce(u.unread_count, 0)               as unread_count
  from public.chat_channels c
  join my_chans   mc on mc.channel_id = c.id
  left join members_agg ma on ma.channel_id = c.id
  left join last_msg    lm on lm.channel_id = c.id
  left join unread      u  on u.channel_id  = c.id
  where c.kind <> 'dm'
     or coalesce(ma.member_count, 0) >= 2
  order by coalesce(lm.last_at, c.created_at) desc;
end;
$$;

grant execute on function public.chat_list_my_channels() to authenticated;
