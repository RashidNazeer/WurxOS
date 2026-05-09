-- ============================================================
-- WurxOS v2 — Migration 037: Chat (channels, members, messages)
--
-- Types:
--   * dm       — exactly 2 members
--   * group    — any members (created by Boss/OL)
--   * role     — pseudo-auto; rows created per role, every user with
--                that role is implicit-member (queried via role_key)
--
-- For simplicity v1 ships with dm + group only (role-channel can be
-- added later).
-- ============================================================

create table if not exists public.chat_channels (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null check (kind in ('dm','group')),
  name       text,                        -- null for DM; display name for group
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.chat_members (
  channel_id uuid not null references public.chat_channels(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  joined_at  timestamptz not null default now(),
  last_read_at timestamptz not null default now(),
  primary key (channel_id, user_id)
);

create index if not exists chat_members_user_idx on public.chat_members(user_id);

create table if not exists public.chat_messages (
  id         uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.chat_channels(id) on delete cascade,
  author_id  uuid not null references public.profiles(id) on delete cascade,
  body       text not null,
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_channel_idx on public.chat_messages(channel_id, created_at desc);

-- RLS
alter table public.chat_channels enable row level security;
alter table public.chat_members  enable row level security;
alter table public.chat_messages enable row level security;

-- Member check helper
create or replace function public.is_chat_member(p_channel uuid, p_uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (select 1 from public.chat_members where channel_id = p_channel and user_id = p_uid);
$$;
grant execute on function public.is_chat_member(uuid, uuid) to authenticated;

-- channels: members can SELECT; creator (or Boss) can INSERT/UPDATE/DELETE
drop policy if exists "chan_select" on public.chat_channels;
create policy "chan_select" on public.chat_channels for select
  using (public.is_chat_member(id, auth.uid()) or public.is_boss(auth.uid()));

drop policy if exists "chan_insert" on public.chat_channels;
create policy "chan_insert" on public.chat_channels for insert
  with check (created_by = auth.uid());

drop policy if exists "chan_update" on public.chat_channels;
create policy "chan_update" on public.chat_channels for update
  using (created_by = auth.uid() or public.is_boss(auth.uid()));

drop policy if exists "chan_delete" on public.chat_channels;
create policy "chan_delete" on public.chat_channels for delete
  using (created_by = auth.uid() or public.is_boss(auth.uid()));

-- members: you see members of channels you're in; you can add yourself
-- on channel creation (via SECURITY DEFINER function); creator/Boss manage.
drop policy if exists "mem_select" on public.chat_members;
create policy "mem_select" on public.chat_members for select
  using (public.is_chat_member(channel_id, auth.uid()) or public.is_boss(auth.uid()));

drop policy if exists "mem_insert" on public.chat_members;
create policy "mem_insert" on public.chat_members for insert
  with check (
    user_id = auth.uid()
    or public.is_boss(auth.uid())
    or exists (select 1 from public.chat_channels c where c.id = chat_members.channel_id and c.created_by = auth.uid())
  );

drop policy if exists "mem_update" on public.chat_members;
create policy "mem_update" on public.chat_members for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "mem_delete" on public.chat_members;
create policy "mem_delete" on public.chat_members for delete
  using (
    user_id = auth.uid()
    or public.is_boss(auth.uid())
    or exists (select 1 from public.chat_channels c where c.id = chat_members.channel_id and c.created_by = auth.uid())
  );

-- messages: member read; member write (as self); author delete; Boss delete
drop policy if exists "msg_select" on public.chat_messages;
create policy "msg_select" on public.chat_messages for select
  using (public.is_chat_member(channel_id, auth.uid()));

drop policy if exists "msg_insert" on public.chat_messages;
create policy "msg_insert" on public.chat_messages for insert
  with check (author_id = auth.uid() and public.is_chat_member(channel_id, auth.uid()));

drop policy if exists "msg_delete" on public.chat_messages;
create policy "msg_delete" on public.chat_messages for delete
  using (author_id = auth.uid() or public.is_boss(auth.uid()));

-- RPC: open-or-create DM with another user (idempotent)
create or replace function public.chat_open_dm(p_other uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_self uuid := auth.uid();
  v_existing uuid;
  v_id uuid;
begin
  if v_self is null or p_other is null or v_self = p_other then
    raise exception 'invalid DM target';
  end if;

  -- Any channel where both are members (dm only)
  select c.id into v_existing
  from public.chat_channels c
  join public.chat_members a on a.channel_id = c.id and a.user_id = v_self
  join public.chat_members b on b.channel_id = c.id and b.user_id = p_other
  where c.kind = 'dm'
  limit 1;
  if v_existing is not null then return v_existing; end if;

  insert into public.chat_channels (kind, created_by) values ('dm', v_self) returning id into v_id;
  insert into public.chat_members (channel_id, user_id) values (v_id, v_self), (v_id, p_other);
  return v_id;
end;
$$;
grant execute on function public.chat_open_dm(uuid) to authenticated;

-- RPC: create a group channel with initial members
create or replace function public.chat_create_group(p_name text, p_members uuid[])
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_self uuid := auth.uid();
  v_id uuid;
  v_member uuid;
begin
  if v_self is null then raise exception 'not authenticated'; end if;
  insert into public.chat_channels (kind, name, created_by)
  values ('group', nullif(trim(p_name), ''), v_self)
  returning id into v_id;

  insert into public.chat_members (channel_id, user_id) values (v_id, v_self);
  foreach v_member in array coalesce(p_members, '{}') loop
    if v_member <> v_self then
      insert into public.chat_members (channel_id, user_id) values (v_id, v_member)
      on conflict do nothing;
    end if;
  end loop;
  return v_id;
end;
$$;
grant execute on function public.chat_create_group(text, uuid[]) to authenticated;

-- Realtime publication
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'chat_messages') then
      execute 'alter publication supabase_realtime add table public.chat_messages';
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'chat_members') then
      execute 'alter publication supabase_realtime add table public.chat_members';
    end if;
  end if;
end;
$$;

-- Notification trigger: ping other members on new messages (in-app only;
-- push gated by notification_prefs.system)
create or replace function public.chat_notify_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid;
  v_actor_name text;
  v_channel_name text;
begin
  v_actor_name := public.profile_display_name(new.author_id);
  select coalesce(name, 'Direct message') into v_channel_name
    from public.chat_channels where id = new.channel_id;

  for v_uid in
    select user_id from public.chat_members
    where channel_id = new.channel_id and user_id <> new.author_id
  loop
    perform public.emit_notification(
      v_uid, new.author_id, 'system', 'chat.message',
      v_actor_name || ' · ' || v_channel_name,
      left(new.body, 140),
      'chat', new.channel_id, '/chat'
    );
  end loop;
  return new;
end;
$$;

drop trigger if exists chat_notify_ai on public.chat_messages;
create trigger chat_notify_ai
  after insert on public.chat_messages
  for each row execute function public.chat_notify_message();
