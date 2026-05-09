-- ============================================================
-- WurxOS v2 — Migration 042: Surface created_by in the chat list
--
-- Adds `created_by` to chat_list_my_channels() so the UI can decide
-- who's allowed to delete a channel for everyone.
-- ============================================================

-- Postgres won't change a function's return-table shape via CREATE OR
-- REPLACE, so drop + recreate.
drop function if exists public.chat_list_my_channels();

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
           ) order by (p.id = v_uid), p.display_name), '[]'::jsonb) as members
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
    coalesce(ma.members, '[]'::jsonb)                       as members,
    lm.last_message,
    coalesce(u.unread_count, 0)                              as unread_count
  from public.chat_channels c
  join my_chans   mc on mc.channel_id = c.id
  left join members_agg ma on ma.channel_id = c.id
  left join last_msg    lm on lm.channel_id = c.id
  left join unread      u  on u.channel_id  = c.id
  order by coalesce(lm.last_at, c.created_at) desc;
end;
$$;
grant execute on function public.chat_list_my_channels() to authenticated;
