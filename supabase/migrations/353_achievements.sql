-- ============================================================
-- WurxOS v2 — Migration 353: Achievements (APC / TL of the Month).
--
-- Boss and OL pick a winner for each achievement, each writes their own short
-- message, set a reward, and announce. The winner gets a full-screen
-- celebration they must acknowledge, and a small reminder on their clock-in
-- widget for the rest of the following month.
--
-- ── SHAPE ──────────────────────────────────────────────────────────────────
-- achievement_types is a TABLE, not an enum: "we will keep adding those". A new
-- award is one INSERT — no migration to the achievements table, no code change
-- beyond a label. Two are seeded.
--
-- One winner per (type, month), enforced by a unique index.
--
-- ── EVERY MUTATION IS AN RPC ───────────────────────────────────────────────
-- The table has SELECT policies and NO insert/update/delete policies at all, so
-- the only way to write it is through the SECURITY DEFINER functions below.
-- That is deliberate: announcing moves money (it writes a bonus onto the
-- winner's incentive plan), and the rules that make it safe — who may write
-- which message, both messages required, the reward booked exactly once — are
-- not expressible as row policies.
--
-- ── THE MONEY, AND WHICH MONTH IT LANDS IN ─────────────────────────────────
-- The Boss chose for the reward to be a real incentive line rather than
-- recognition only. It is written as a bonus on the winner's plan for the month
-- the announcement is MADE in, not the month being awarded.
--
-- That is the important decision here. "APC of the Month for August" is
-- announced in September, and August's incentives are typically already
-- verified and paid — mig 351 made the freeze chain real, so writing into a
-- signed-off month would either be refused or would quietly reopen settled pay.
-- A bonus paid in the current cycle, labelled with the month it is for, is both
-- how the money actually moves and the only version that cannot disturb history.
--
-- If the announcement month's plan is itself already verified or cleared, the
-- announcement is REFUSED with a message saying so, rather than silently
-- dropping the reward or amending a signed-off row.
--
-- The bonus carries source='achievement' so it is identifiable, and its item id
-- is stored back on the achievement row, so the link survives even though the
-- OL page's save path rebuilds items from a fixed field list.
--
-- Idempotent.
-- ============================================================

-- ── 1. Types ────────────────────────────────────────────────────────────────
create table if not exists public.achievement_types (
  key            text primary key,
  label          text not null,
  blurb          text,
  eligible_roles text[] not null,
  sort_order     int not null default 0,
  is_active      boolean not null default true
);

insert into public.achievement_types (key, label, blurb, eligible_roles, sort_order)
values
  ('apc_of_the_month', 'APC of the Month',
   'The Affiliate Partnerships Coordinator who set the standard this month.',
   array['apc'], 10),
  ('tl_of_the_month',  'TL of the Month',
   'The Team Lead whose team delivered the strongest month.',
   array['tl'], 20)
on conflict (key) do nothing;

alter table public.achievement_types enable row level security;
drop policy if exists "ach_types_select" on public.achievement_types;
create policy "ach_types_select" on public.achievement_types
  for select using (auth.uid() is not null);

-- ── 2. Awards ───────────────────────────────────────────────────────────────
create table if not exists public.achievements (
  id              uuid primary key default gen_random_uuid(),
  type_key        text not null references public.achievement_types(key) on delete restrict,
  month           text not null,                       -- 'YYYY-MM', the month being awarded
  winner_id       uuid references public.profiles(id) on delete restrict,
  reward_amount   numeric not null default 0 check (reward_amount >= 0),

  -- 100 characters each, the Boss's stated limit, enforced here rather than in
  -- the textarea alone.
  boss_message    text check (boss_message is null or char_length(boss_message) <= 100),
  ol_message      text check (ol_message   is null or char_length(ol_message)   <= 100),
  boss_message_by uuid references public.profiles(id) on delete set null,
  ol_message_by   uuid references public.profiles(id) on delete set null,

  status          text not null default 'draft'
                    check (status in ('draft','announced','acknowledged')),
  announced_at    timestamptz,
  announced_by    uuid references public.profiles(id) on delete set null,
  announce_count  int not null default 0,
  acknowledged_at timestamptz,

  -- Where the reward was booked, so it is traceable and can never double-book.
  incentive_row_id  uuid references public.incentives(id) on delete set null,
  incentive_item_id text,
  incentive_month   text,

  created_at      timestamptz not null default now(),
  created_by      uuid references public.profiles(id) on delete set null,
  updated_at      timestamptz not null default now()
);

create unique index if not exists achievements_type_month_uidx
  on public.achievements(type_key, month);
create index if not exists achievements_winner_idx
  on public.achievements(winner_id, status);

alter table public.achievements enable row level security;

-- Boss / OL / Developer manage; a winner sees their OWN award, but only once it
-- has been announced — nobody should discover they are a draft nomination.
drop policy if exists "ach_select" on public.achievements;
create policy "ach_select" on public.achievements
  for select using (
    public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p
                where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
    or (winner_id = auth.uid() and status <> 'draft')
  );
-- No insert / update / delete policies, on purpose. See the header.

drop trigger if exists achievements_touch on public.achievements;
create trigger achievements_touch before update on public.achievements
  for each row execute function public.touch_updated_at();

-- ── 3. Who may manage ───────────────────────────────────────────────────────
create or replace function public.can_manage_achievements(uid uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.is_boss(uid)
      or exists (select 1 from public.profiles p
                  where p.id = uid and p.role in ('ol','developer') and p.is_active = true);
$$;
revoke all on function public.can_manage_achievements(uuid) from public, anon;
grant execute on function public.can_manage_achievements(uuid) to authenticated;

-- ── 4. Create / update the draft ────────────────────────────────────────────
create or replace function public.achievement_upsert(
  p_type_key text,
  p_month    text,
  p_winner_id uuid,
  p_reward   numeric
)
returns public.achievements
language plpgsql security definer set search_path = public
as $$
declare
  v_me    uuid := auth.uid();
  v_roles text[];
  v_role  text;
  v_row   public.achievements;
begin
  if not public.can_manage_achievements(v_me) then
    raise exception 'only the Boss or an Operations Lead can manage achievements';
  end if;
  if p_month !~ '^\d{4}-\d{2}$' then
    raise exception 'month must look like YYYY-MM';
  end if;

  select eligible_roles into v_roles from public.achievement_types where key = p_type_key;
  if v_roles is null then raise exception 'unknown achievement'; end if;

  if p_winner_id is not null then
    select role into v_role from public.profiles
     where id = p_winner_id and is_active = true and deleted_at is null;
    if v_role is null then
      raise exception 'that person is not an active employee';
    end if;
    if not (v_role = any (v_roles)) then
      raise exception 'a % cannot win this achievement', v_role;
    end if;
  end if;

  insert into public.achievements (type_key, month, winner_id, reward_amount, created_by)
  values (p_type_key, p_month, p_winner_id, coalesce(p_reward, 0), v_me)
  on conflict (type_key, month) do update
    set winner_id     = excluded.winner_id,
        reward_amount = excluded.reward_amount
  returning * into v_row;

  -- The conflict branch above would otherwise let a settled award be rewritten.
  if v_row.status <> 'draft' then
    raise exception 'this achievement has already been announced — the winner and reward are fixed';
  end if;

  return v_row;
end;
$$;

-- ── 5. Messages — each writes their own ─────────────────────────────────────
create or replace function public.achievement_set_message(p_id uuid, p_message text)
returns public.achievements
language plpgsql security definer set search_path = public
as $$
declare
  v_me   uuid := auth.uid();
  v_role text;
  v_msg  text := nullif(btrim(coalesce(p_message, '')), '');
  v_row  public.achievements;
begin
  if not public.can_manage_achievements(v_me) then
    raise exception 'only the Boss or an Operations Lead can write an achievement message';
  end if;
  if v_msg is not null and char_length(v_msg) > 100 then
    raise exception 'keep it to 100 characters — this one is %', char_length(v_msg);
  end if;

  select status into v_row.status from public.achievements where id = p_id;
  if not found then raise exception 'achievement not found'; end if;
  if v_row.status <> 'draft' then
    raise exception 'this achievement has already been announced — its messages are fixed';
  end if;

  select role into v_role from public.profiles where id = v_me;

  -- The Boss writes the Boss's line, an OL writes the OL's line, and neither
  -- can put words in the other's mouth: the popup presents them as two named
  -- people, so authorship has to be real.
  if public.is_boss(v_me) then
    update public.achievements
       set boss_message = v_msg, boss_message_by = case when v_msg is null then null else v_me end
     where id = p_id returning * into v_row;
  elsif v_role in ('ol','developer') then
    update public.achievements
       set ol_message = v_msg, ol_message_by = case when v_msg is null then null else v_me end
     where id = p_id returning * into v_row;
  else
    raise exception 'only the Boss or an Operations Lead can write an achievement message';
  end if;

  return v_row;
end;
$$;

-- ── 6. Announce (and re-announce until it is seen) ──────────────────────────
create or replace function public.achievement_announce(p_id uuid)
returns public.achievements
language plpgsql security definer set search_path = public
as $$
declare
  v_me      uuid := auth.uid();
  v_row     public.achievements;
  v_label   text;
  v_month   text := to_char((now() at time zone 'Asia/Karachi'), 'YYYY-MM');
  v_inc     public.incentives;
  v_item_id text;
  v_item    jsonb;
begin
  if not public.can_manage_achievements(v_me) then
    raise exception 'only the Boss or an Operations Lead can announce an achievement';
  end if;

  select * into v_row from public.achievements where id = p_id for update;
  if not found then raise exception 'achievement not found'; end if;

  if v_row.status = 'acknowledged' then
    raise exception 'the winner has already seen this — it cannot be announced again';
  end if;
  if v_row.winner_id is null then
    raise exception 'pick a winner first';
  end if;
  if v_row.boss_message is null or v_row.ol_message is null then
    raise exception 'both the Boss and the OL message are needed before announcing';
  end if;

  select label into v_label from public.achievement_types where key = v_row.type_key;

  -- ── The money, booked exactly once ──────────────────────────────────────
  -- incentive_item_id is the idempotency key: a re-announce (the winner never
  -- saw the first one) must not pay the reward twice.
  if v_row.reward_amount > 0 and v_row.incentive_item_id is null then
    select * into v_inc from public.incentives
     where user_id = v_row.winner_id and month = v_month;

    if found and (v_inc.verified or v_inc.payout_cleared) then
      raise exception
        'the winner''s % incentives are already verified — un-verify that month before announcing, or the reward cannot be added',
        v_month;
    end if;

    if not found then
      -- The plan for this month may not exist yet. Create the shell rather than
      -- dropping the reward on the floor; basic_salary follows the same source
      -- of truth the rollover uses.
      insert into public.incentives (user_id, month, basic_salary, incentives, bonuses)
      values (
        v_row.winner_id, v_month,
        coalesce((select ec.basic_salary from public.employee_compensation ec
                   where ec.user_id = v_row.winner_id), 0),
        '[]'::jsonb, '[]'::jsonb
      )
      returning * into v_inc;
    end if;

    v_item_id := 'ach_' || replace(v_row.id::text, '-', '');
    v_item := jsonb_build_object(
      'id',            v_item_id,
      'text',          v_label || ' — ' || v_row.month,
      'amount',        v_row.reward_amount,
      'targetValue',   1,
      'achievedValue', 1,
      'completed',     true,
      'completedBy',   coalesce(public.profile_display_name(v_me), 'Management'),
      'source',        'achievement'
    );

    -- The RPC has established authority; stand the row guard down (mig 351).
    perform set_config('wurxos.trusted_write', 'on', true);
    update public.incentives
       set bonuses = coalesce(bonuses, '[]'::jsonb) || jsonb_build_array(v_item)
     where id = v_inc.id;

    v_row.incentive_row_id  := v_inc.id;
    v_row.incentive_item_id := v_item_id;
    v_row.incentive_month   := v_month;
  end if;

  update public.achievements
     set status         = 'announced',
         announced_at   = coalesce(announced_at, now()),
         announced_by   = v_me,
         announce_count = announce_count + 1,
         incentive_row_id  = coalesce(incentive_row_id,  v_row.incentive_row_id),
         incentive_item_id = coalesce(incentive_item_id, v_row.incentive_item_id),
         incentive_month   = coalesce(incentive_month,   v_row.incentive_month)
   where id = p_id
   returning * into v_row;

  -- They may be anywhere when this fires, so the notification is the reach and
  -- the popup is what greets them when they come back.
  perform public.emit_notification(
    v_row.winner_id, v_me, 'system', 'achievement.announced',
    'You won ' || v_label || '!',
    'Congratulations — you are ' || v_label || ' for ' || v_row.month
      || '. Open WurxOS to see your award.',
    'achievement', v_row.id, '/dashboard'
  );

  return v_row;
end;
$$;

-- ── 7. The winner closes it ─────────────────────────────────────────────────
create or replace function public.achievement_acknowledge(p_id uuid)
returns public.achievements
language plpgsql security definer set search_path = public
as $$
declare
  v_me  uuid := auth.uid();
  v_row public.achievements;
begin
  select * into v_row from public.achievements where id = p_id;
  if not found then raise exception 'achievement not found'; end if;
  if v_row.winner_id <> v_me then
    raise exception 'only the winner can close their own award';
  end if;
  if v_row.status = 'draft' then
    raise exception 'this award has not been announced yet';
  end if;

  update public.achievements
     set status = 'acknowledged',
         acknowledged_at = coalesce(acknowledged_at, now())
   where id = p_id
   returning * into v_row;

  return v_row;
end;
$$;

-- ── 8. What the signed-in user should see right now ─────────────────────────
-- One call, two answers: the popup they owe an acknowledgement, and the
-- lingering "keep it up" line for the clock-in widget.
--
-- The banner runs from the announcement to the END OF THE MONTH AFTER the month
-- awarded — August's award, announced in September, shows all through
-- September. That is the Boss's "for the whole month", with an end date that
-- does not depend on when the announcement happened to be made.
create or replace function public.achievement_for_me()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_me     uuid := auth.uid();
  v_today  date := (now() at time zone 'Asia/Karachi')::date;
  v_pending jsonb;
  v_banner  jsonb;
begin
  if v_me is null then return jsonb_build_object('pending', null, 'banner', null); end if;

  select to_jsonb(x) into v_pending from (
    select a.id, a.month, a.reward_amount, a.boss_message, a.ol_message,
           t.label as type_label, t.blurb,
           public.profile_display_name(a.winner_id)       as winner_name,
           public.profile_display_name(a.boss_message_by) as boss_name,
           public.profile_display_name(a.ol_message_by)   as ol_name,
           (select p.role from public.profiles p where p.id = a.boss_message_by) as boss_role,
           (select p.role from public.profiles p where p.id = a.ol_message_by)   as ol_role
      from public.achievements a
      join public.achievement_types t on t.key = a.type_key
     where a.winner_id = v_me and a.status = 'announced'
     order by a.announced_at
     limit 1
  ) x;

  select to_jsonb(y) into v_banner from (
    select a.id, a.month, t.label as type_label
      from public.achievements a
      join public.achievement_types t on t.key = a.type_key
     where a.winner_id = v_me
       and a.status = 'acknowledged'
       and v_today <= (date_trunc('month', to_date(a.month || '-01', 'YYYY-MM-DD'))
                        + interval '2 months - 1 day')::date
     order by a.month desc
     limit 1
  ) y;

  return jsonb_build_object('pending', v_pending, 'banner', v_banner);
end;
$$;

-- ── 9. Who deserves it — a suggestion, never a decision ─────────────────────
create or replace function public.achievement_candidates(p_type_key text, p_month text)
returns table (user_id uuid, display_name text, role text, composite_score numeric, level text)
language plpgsql stable security definer set search_path = public
as $$
declare
  v_roles text[];
begin
  if not public.can_manage_achievements(auth.uid()) then
    raise exception 'not authorized';
  end if;
  select eligible_roles into v_roles from public.achievement_types where key = p_type_key;
  if v_roles is null then raise exception 'unknown achievement'; end if;

  return query
    select p.id, p.display_name, p.role,
           c.composite_score, c.level
      from public.profiles p
      left join lateral public.get_performance_composite(p.id, p_month) c on true
     where p.role = any (v_roles) and p.is_active = true and p.deleted_at is null
     order by c.composite_score desc nulls last, p.display_name;
end;
$$;

-- ── 10. Grants — authenticated only; anon is granted by default (mig 348) ───
do $grants$
declare v_fn text;
begin
  foreach v_fn in array array[
    'public.achievement_upsert(text, text, uuid, numeric)',
    'public.achievement_set_message(uuid, text)',
    'public.achievement_announce(uuid)',
    'public.achievement_acknowledge(uuid)',
    'public.achievement_for_me()',
    'public.achievement_candidates(text, text)'
  ] loop
    execute format('revoke all on function %s from public', v_fn);
    execute format('revoke all on function %s from anon',   v_fn);
    execute format('grant execute on function %s to authenticated', v_fn);
  end loop;
end;
$grants$;

-- Realtime so a winner who happens to be looking at the app when Announce is
-- pressed sees the celebration straight away rather than on their next
-- navigation. `add table` errors if the table is already a member, hence the
-- guard — this file has to stay re-runnable.
do $realtime$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'achievements'
  ) then
    alter publication supabase_realtime add table public.achievements;
  end if;
end;
$realtime$;

-- ── 11. Verification ────────────────────────────────────────────────────────
do $verify$
declare
  v_cnt int;
  v_fn  text;
begin
  select count(*) into v_cnt from public.achievement_types where is_active;
  if v_cnt < 2 then raise exception 'mig 353: the two achievement types were not seeded'; end if;

  -- The table must be writable ONLY through the RPCs: a stray insert/update
  -- policy would let a manager (or a winner) bypass the money rules.
  select count(*) into v_cnt from pg_policies
   where schemaname = 'public' and tablename = 'achievements' and cmd <> 'SELECT';
  if v_cnt <> 0 then
    raise exception 'mig 353: achievements has % non-SELECT policies — mutations must stay RPC-only', v_cnt;
  end if;

  foreach v_fn in array array[
    'public.achievement_upsert(text, text, uuid, numeric)',
    'public.achievement_set_message(uuid, text)',
    'public.achievement_announce(uuid)',
    'public.achievement_acknowledge(uuid)',
    'public.achievement_for_me()',
    'public.achievement_candidates(text, text)'
  ] loop
    if has_function_privilege('anon', v_fn, 'execute') then
      raise exception 'mig 353: anon can call %', v_fn;
    end if;
    if not has_function_privilege('authenticated', v_fn, 'execute') then
      raise exception 'mig 353: authenticated cannot call %', v_fn;
    end if;
  end loop;

  raise notice 'mig 353: achievements ready — % types seeded, mutations are RPC-only', 2;
end;
$verify$;
