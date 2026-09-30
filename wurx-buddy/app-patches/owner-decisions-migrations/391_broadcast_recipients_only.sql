-- ============================================================
-- WurxOS v2 — Migration 391: broadcasts and polls are for their recipients
--
-- Owner decision (2026-10). Until now bc_select was `auth.uid() is not null`
-- (mig 066), so every employee saw the latest 50 broadcasts company-wide,
-- and broadcast_respond (mig 068) took an answer from anyone.
--
-- Now:
--   • broadcast_recipients records who a broadcast was sent to. It is written
--     by dispatch_broadcast at send time, so later team/brand changes don't
--     rewrite history. Notifications can't serve as the record, because
--     users may delete their own notifications.
--   • A broadcast is visible to its recipients, its sender and the Boss.
--   • Only recipients can answer a poll.
--   • Results are for the sender and the Boss (OL/developer lose the global
--     read of responses).
--   • Re-notify goes only to recipients.
--
-- Backfill for broadcasts already sent (triggers don't fire retroactively):
-- people who got the notification or answered, plus anyone the target rule
-- matches who existed at send time. Idempotent throughout.
-- ============================================================

create table if not exists public.broadcast_recipients (
  broadcast_id uuid not null references public.broadcasts(id) on delete cascade,
  user_id      uuid not null references public.profiles(id)   on delete cascade,
  primary key (broadcast_id, user_id)
);
create index if not exists brcp_user_idx on public.broadcast_recipients(user_id);

alter table public.broadcast_recipients enable row level security;

-- SECURITY DEFINER, so the broadcasts and broadcast_recipients policies can
-- both use it without recursing into each other.
create or replace function public.broadcast_visible(p_id uuid, p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_uid is not null and (
    public.is_boss(p_uid)
    or exists (select 1 from public.broadcasts b where b.id = p_id and b.author_id = p_uid)
    or exists (select 1 from public.broadcast_recipients r where r.broadcast_id = p_id and r.user_id = p_uid)
  );
$$;
revoke execute on function public.broadcast_visible(uuid, uuid) from public, anon;
grant execute on function public.broadcast_visible(uuid, uuid) to authenticated;

-- Rows are written only by dispatch_broadcast (definer); no user write policy.
drop policy if exists "brcp_select" on public.broadcast_recipients;
create policy "brcp_select"
  on public.broadcast_recipients for select
  using (
    user_id = auth.uid()
    or public.is_boss(auth.uid())
    or exists (select 1 from public.broadcasts b where b.id = broadcast_recipients.broadcast_id and b.author_id = auth.uid())
  );

-- author_id is checked on the row itself: createBroadcast inserts with
-- RETURNING, and the helper's lookup can't see a row its own statement is
-- inserting.
drop policy if exists "bc_select" on public.broadcasts;
create policy "bc_select"
  on public.broadcasts for select
  using (author_id = auth.uid() or public.broadcast_visible(id, auth.uid()));

drop policy if exists "brspn_select" on public.broadcast_responses;
create policy "brspn_select"
  on public.broadcast_responses for select
  using (
    user_id = auth.uid()
    or public.is_boss(auth.uid())
    or exists (select 1 from public.broadcasts b where b.id = broadcast_responses.broadcast_id and b.author_id = auth.uid())
  );

drop policy if exists "brspn_write" on public.broadcast_responses;
create policy "brspn_write"
  on public.broadcast_responses for all
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.broadcast_recipients r
                 where r.broadcast_id = broadcast_responses.broadcast_id and r.user_id = auth.uid())
  );

-- --------------------------------------------------------------
-- Dispatch: as mig 066, plus the recipient record.
-- --------------------------------------------------------------
create or replace function public.dispatch_broadcast(p_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.broadcasts;
  v_uid uuid;
  v_count int := 0;
begin
  select * into v_row from public.broadcasts where id = p_id;
  if not found or v_row.sent_at is not null then return 0; end if;

  for v_uid in
    select p.id from public.profiles p
    where p.is_active = true
      and (
        v_row.target = 'all'
        or (v_row.target = 'role'    and p.role = any (v_row.target_roles))
        or (v_row.target = 'users'   and p.id  = any (v_row.target_user_ids))
        or (v_row.target = 'my_team' and p.reports_to = v_row.author_id)
        or (v_row.target = 'brand'   and (
              p.id = (select owner_id from public.brands where id = v_row.target_brand_id)
              or exists (
                select 1 from public.brand_assignments ba
                where ba.brand_id = v_row.target_brand_id and ba.user_id = p.id
              )
            ))
      )
      and p.id <> coalesce(v_row.author_id, '00000000-0000-0000-0000-000000000000'::uuid)
  loop
    insert into public.broadcast_recipients (broadcast_id, user_id)
    values (p_id, v_uid) on conflict do nothing;
    perform public.emit_notification(
      v_uid, v_row.author_id, 'system', 'broadcast',
      v_row.title, v_row.body, 'broadcast', v_row.id, '/broadcasts'
    );
    v_count := v_count + 1;
  end loop;

  update public.broadcasts set sent_at = now(), sent_count = v_count where id = p_id;
  return v_count;
end;
$$;

-- --------------------------------------------------------------
-- Poll RPCs: as mig 068, plus the recipient checks.
-- --------------------------------------------------------------
create or replace function public.broadcast_respond(
  p_id           uuid,
  p_option_id    text,
  p_option_label text default null
)
returns public.broadcast_responses
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me  uuid := auth.uid();
  v_row public.broadcast_responses;
begin
  if v_me is null then raise exception 'not authenticated'; end if;
  if not exists (select 1 from public.broadcast_recipients where broadcast_id = p_id and user_id = v_me) then
    raise exception 'only recipients can respond to this broadcast';
  end if;

  insert into public.broadcast_responses (broadcast_id, user_id, option_id, option_label, responded_at)
  values (p_id, v_me, p_option_id, p_option_label, now())
  on conflict (broadcast_id, user_id)
  do update set option_id    = excluded.option_id,
                option_label = excluded.option_label,
                responded_at = now()
  returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.broadcast_renotify(
  p_id      uuid,
  p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me    uuid := auth.uid();
  v_bcast public.broadcasts;
begin
  if v_me is null then raise exception 'not authenticated'; end if;

  select * into v_bcast from public.broadcasts where id = p_id;
  if not found then raise exception 'broadcast not found'; end if;
  if v_bcast.author_id <> v_me then raise exception 'only the broadcast author can re-notify'; end if;
  if not exists (select 1 from public.broadcast_recipients where broadcast_id = p_id and user_id = p_user_id) then
    raise exception 'that person is not a recipient of this broadcast';
  end if;

  if exists (
    select 1 from public.broadcast_responses
    where broadcast_id = p_id and user_id = p_user_id
  ) then
    return;  -- already responded; nothing to do
  end if;

  perform public.emit_notification(
    p_user_id, v_me, 'system', 'broadcast_reminder',
    'Reminder: ' || v_bcast.title,
    coalesce(
      (select display_name from public.profiles where id = v_me),
      'The sender'
    ) || ' is reminding you to respond.',
    'broadcast', p_id, '/broadcasts'
  );
end;
$$;

create or replace function public.broadcast_renotify_pending(p_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me     uuid := auth.uid();
  v_bcast  public.broadcasts;
  v_uid    uuid;
  v_count  int := 0;
begin
  if v_me is null then raise exception 'not authenticated'; end if;

  select * into v_bcast from public.broadcasts where id = p_id;
  if not found then raise exception 'broadcast not found'; end if;
  if v_bcast.author_id <> v_me then raise exception 'only the broadcast author can re-notify'; end if;

  for v_uid in
    select r.user_id from public.broadcast_recipients r
      join public.profiles p on p.id = r.user_id and p.is_active = true
     where r.broadcast_id = p_id
       and not exists (
         select 1 from public.broadcast_responses s
          where s.broadcast_id = p_id and s.user_id = r.user_id
       )
  loop
    perform public.emit_notification(
      v_uid, v_me, 'system', 'broadcast_reminder',
      'Reminder: ' || v_bcast.title,
      coalesce(
        (select display_name from public.profiles where id = v_me),
        'The sender'
      ) || ' is reminding you to respond.',
      'broadcast', p_id, '/broadcasts'
    );
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- --------------------------------------------------------------
-- Backfill already-sent broadcasts.
-- --------------------------------------------------------------
insert into public.broadcast_recipients (broadcast_id, user_id)
select n.entity_id, n.recipient_id
  from public.notifications n
  join public.broadcasts b on b.id = n.entity_id
 where n.entity_type = 'broadcast' and n.action = 'broadcast'
on conflict do nothing;

insert into public.broadcast_recipients (broadcast_id, user_id)
select r.broadcast_id, r.user_id from public.broadcast_responses r
on conflict do nothing;

insert into public.broadcast_recipients (broadcast_id, user_id)
select b.id, p.id
  from public.broadcasts b
  join public.profiles p
    on p.created_at <= b.sent_at
   and p.id <> coalesce(b.author_id, '00000000-0000-0000-0000-000000000000'::uuid)
   and (
        b.target = 'all'
     or (b.target = 'role'    and p.role = any (b.target_roles))
     or (b.target = 'users'   and p.id  = any (b.target_user_ids))
     or (b.target = 'my_team' and p.reports_to = b.author_id)
     or (b.target = 'brand'   and (
           p.id = (select owner_id from public.brands where id = b.target_brand_id)
           or exists (select 1 from public.brand_assignments ba where ba.brand_id = b.target_brand_id and ba.user_id = p.id)
         ))
   )
 where b.sent_at is not null
on conflict do nothing;
