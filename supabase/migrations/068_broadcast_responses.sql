-- ============================================================
-- Migration 068 — Broadcasts: poll responses
--
-- v1 parity: a broadcast can carry an array of response_options
-- (like a WhatsApp poll). Recipients tap an option; the author sees
-- who picked what. Only the author views aggregates; recipients see
-- only their own response. Author can "re-notify" pending people.
--
-- Schema:
--   broadcasts.response_options jsonb  — array of {id, label}
--   broadcasts.response_count   int    — denormalized (trigger-kept)
--   broadcast_responses table          — one row per user per broadcast
-- ============================================================

alter table public.broadcasts
  add column if not exists response_options jsonb not null default '[]'::jsonb,
  add column if not exists response_count   int   not null default 0;

-- --------------------------------------------------------------
-- broadcast_responses — one response per user per broadcast
-- --------------------------------------------------------------
create table if not exists public.broadcast_responses (
  broadcast_id uuid not null references public.broadcasts(id) on delete cascade,
  user_id      uuid not null references public.profiles(id)  on delete cascade,
  option_id    text not null,
  option_label text,
  responded_at timestamptz not null default now(),
  primary key (broadcast_id, user_id)
);

create index if not exists brspn_user_idx      on public.broadcast_responses(user_id);
create index if not exists brspn_broadcast_idx on public.broadcast_responses(broadcast_id);

alter table public.broadcast_responses enable row level security;

-- SELECT: the respondent sees their own row; the broadcast author sees
-- all rows for their broadcast; admins see everything.
drop policy if exists "brspn_select" on public.broadcast_responses;
create policy "brspn_select"
  on public.broadcast_responses for select
  using (
    user_id = auth.uid()
    or public.is_boss(auth.uid())
    or exists (
      select 1 from public.broadcasts b
      where b.id = broadcast_responses.broadcast_id
        and b.author_id = auth.uid()
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true
    )
  );

-- INSERT / UPDATE: authenticated users can write their own response.
drop policy if exists "brspn_write" on public.broadcast_responses;
create policy "brspn_write"
  on public.broadcast_responses for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- --------------------------------------------------------------
-- Keep broadcasts.response_count in sync with the responses table
-- --------------------------------------------------------------
create or replace function public.broadcast_response_count_trigger()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    update public.broadcasts
       set response_count = coalesce(response_count, 0) + 1
     where id = new.broadcast_id;
  elsif tg_op = 'DELETE' then
    update public.broadcasts
       set response_count = greatest(0, coalesce(response_count, 0) - 1)
     where id = old.broadcast_id;
  end if;
  return null;
end;
$$;

drop trigger if exists brspn_count on public.broadcast_responses;
create trigger brspn_count
  after insert or delete on public.broadcast_responses
  for each row execute function public.broadcast_response_count_trigger();

-- --------------------------------------------------------------
-- RPCs
-- --------------------------------------------------------------

-- Submit or change a response. Idempotent — same-option-twice is a no-op
-- (conceptually). Returns the row. Count handled by trigger.
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
grant execute on function public.broadcast_respond(uuid, text, text) to authenticated;

-- Author-only: re-notify a specific user that still hasn't responded.
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
grant execute on function public.broadcast_renotify(uuid, uuid) to authenticated;

-- Author-only: re-notify everyone who would have received this
-- broadcast and hasn't responded yet.
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
    select p.id from public.profiles p
    where p.is_active = true
      and p.id <> v_me
      and (
        v_bcast.target = 'all'
        or (v_bcast.target = 'role'    and p.role = any (v_bcast.target_roles))
        or (v_bcast.target = 'users'   and p.id  = any (v_bcast.target_user_ids))
        or (v_bcast.target = 'my_team' and p.reports_to = v_bcast.author_id)
        or (v_bcast.target = 'brand'   and (
              p.id = (select owner_id from public.brands where id = v_bcast.target_brand_id)
              or exists (
                select 1 from public.brand_assignments ba
                where ba.brand_id = v_bcast.target_brand_id and ba.user_id = p.id
              )
            ))
      )
      and not exists (
        select 1 from public.broadcast_responses r
        where r.broadcast_id = p_id and r.user_id = p.id
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
grant execute on function public.broadcast_renotify_pending(uuid) to authenticated;
