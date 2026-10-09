-- ============================================================
-- WurxOS v2 — Migration 419: the Boss can stop someone and make them read
--
-- ── THE ASK (Owner, 2026-10-09) ────────────────────────────────────────────
-- The Boss writes a message to one person. That person cannot use WurxOS until
-- they press Acknowledge — and the message STAYS on their screen, still
-- blocking, until the Boss switches it off. Optionally the Boss asks for a
-- written reply before the button unlocks.
--
-- ── WHAT THAT MEANS, SAID PLAINLY ─────────────────────────────────────────
-- An active row here LOCKS A REAL PERSON OUT OF THE WHOLE APP, including
-- clocking in. Attendance feeds the performance score, which feeds incentives,
-- so a message left on overnight can cost someone money. The Owner chose this
-- deliberately; the Settings screen therefore shows a running count of who is
-- locked out, and `ack_locked_out()` below is what feeds it.
--
-- ── THE RULES, ENFORCED HERE AND NOT IN THE SCREEN ────────────────────────
--   * Only the Boss writes. The screen also hides the form, but a hidden form
--     is not a boundary — any signed-in user can POST to PostgREST.
--   * The Boss cannot be a recipient. Nobody gets to lock the one person who
--     holds the off switch out of the off switch (themselves included).
--   * One active message per person. A second one would queue invisibly behind
--     the first and the Boss would never know why it "did nothing".
--   * Acknowledging goes through ack_acknowledge() only. A recipient may never
--     UPDATE the row directly: given the chance they could flip `active` and
--     walk straight out of the lock.
--   * The reply IS stored. The dialog promises "your response will be shared
--     with Rashid"; discarding it would make the app lie to the person typing.
--
-- Idempotent.
-- ============================================================

create table if not exists public.ack_messages (
  id                uuid primary key default gen_random_uuid(),
  recipient_id      uuid not null references public.profiles(id) on delete cascade,
  title             text,
  body              text not null,
  require_reply     boolean not null default false,
  reply_placeholder text,
  active            boolean not null default true,
  created_by        uuid references public.profiles(id) on delete set null,
  created_at        timestamptz not null default now(),
  acknowledged_at   timestamptz,
  reply_text        text,
  released_at       timestamptz,
  released_by       uuid references public.profiles(id) on delete set null,
  constraint ack_body_not_blank check (btrim(body) <> '')
);

-- One ACTIVE message per person (see the header). Released rows stay as history.
create unique index if not exists ack_one_active_per_person
  on public.ack_messages (recipient_id) where active;

create index if not exists ack_recipient_idx on public.ack_messages (recipient_id, created_at desc);

alter table public.ack_messages enable row level security;

-- ── who may see what ───────────────────────────────────────────────────────
-- The recipient reads their own rows (the gate needs the active one, and the
-- "thanks" state needs it to stay readable after acknowledging). The Boss reads
-- everything, because the Settings list is the only place the off switch lives.
drop policy if exists ack_select on public.ack_messages;
create policy ack_select on public.ack_messages for select
  using (recipient_id = auth.uid() or public.is_boss(auth.uid()));

-- Writes are the Boss's alone. The recipient's one legal write is the RPC
-- below, which runs as definer and checks the caller itself.
drop policy if exists ack_insert on public.ack_messages;
create policy ack_insert on public.ack_messages for insert
  with check (public.is_boss(auth.uid()) and not public.is_boss(recipient_id));

drop policy if exists ack_update on public.ack_messages;
create policy ack_update on public.ack_messages for update
  using (public.is_boss(auth.uid()))
  with check (public.is_boss(auth.uid()));

drop policy if exists ack_delete on public.ack_messages;
create policy ack_delete on public.ack_messages for delete
  using (public.is_boss(auth.uid()));

revoke all on public.ack_messages from anon;
grant select, insert, update, delete on public.ack_messages to authenticated;


-- ── the one thing the recipient may do ────────────────────────────────────
-- Records the acknowledgement and the reply. It deliberately does NOT clear
-- `active`: the message keeps blocking until the Boss releases it, which is the
-- whole point of the feature.
create or replace function public.ack_acknowledge(p_id uuid, p_reply text default null)
returns public.ack_messages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.ack_messages;
begin
  select * into v_row from public.ack_messages
   where id = p_id and recipient_id = auth.uid() and active
   for update;

  if not found then
    raise exception 'no active message for you' using errcode = '42501';
  end if;

  -- Already acknowledged: hand the row back unchanged rather than overwriting
  -- the first reply and its timestamp with a second press.
  if v_row.acknowledged_at is not null then
    return v_row;
  end if;

  if v_row.require_reply and coalesce(btrim(p_reply), '') = '' then
    raise exception 'a written reply is required';
  end if;

  update public.ack_messages
     set acknowledged_at = now(),
         reply_text = case when v_row.require_reply then btrim(p_reply) else nullif(btrim(p_reply), '') end
   where id = p_id
   returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.ack_acknowledge(uuid, text) from public, anon;
grant execute on function public.ack_acknowledge(uuid, text) to authenticated;


-- ── how many people are currently locked out ──────────────────────────────
-- Feeds the counter on the Settings screen. Boss only: it is a count of people,
-- but it is still a statement about who is being disciplined.
create or replace function public.ack_locked_out()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select case when public.is_boss(auth.uid())
              then (select count(*)::int from public.ack_messages where active)
              else 0 end;
$$;

revoke all on function public.ack_locked_out() from public, anon;
grant execute on function public.ack_locked_out() to authenticated;


-- ── verification ──────────────────────────────────────────────────────────
do $verify$
declare
  v_boss uuid;
  v_victim uuid;
  v_id uuid;
  v_blocked boolean := false;
begin
  select id into v_boss from public.profiles where role = 'boss' and is_active limit 1;
  select id into v_victim from public.profiles
   where role <> 'boss' and is_active and deleted_at is null limit 1;
  if v_boss is null or v_victim is null then
    raise notice '419: no boss/non-boss pair to verify with — table created, behaviour unverified';
    return;
  end if;

  insert into public.ack_messages (recipient_id, body, require_reply, created_by)
  values (v_victim, 'verification row (419)', true, v_boss)
  returning id into v_id;

  -- A reply is required, so an empty one must be refused.
  begin
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_victim, 'role', 'authenticated')::text, true);
    perform public.ack_acknowledge(v_id, '   ');
  exception when others then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception '419: an empty reply was accepted while require_reply is true';
  end if;

  -- A real reply is recorded, and the row STAYS active.
  -- NOTE: the exception above rolled back to the implicit savepoint, which also
  -- undid set_config — so the claims have to be set again or this call runs as
  -- nobody and fails with "no active message for you".
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_victim, 'role', 'authenticated')::text, true);
  perform public.ack_acknowledge(v_id, 'understood');
  perform set_config('request.jwt.claims', null, true);

  if not exists (select 1 from public.ack_messages
                  where id = v_id and active and acknowledged_at is not null
                    and reply_text = 'understood') then
    raise exception '419: acknowledging did not record the reply, or it cleared active';
  end if;

  delete from public.ack_messages where id = v_id;
  raise notice '419: acknowledgement recorded, reply stored, message stays active until released';
end;
$verify$;
