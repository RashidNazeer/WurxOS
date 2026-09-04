-- ============================================================
-- WurxOS v2 — Migration 354: one achievement message, not two, and no byline.
--
-- Mig 353 gave each award a Boss line and an OL line, each shown in the
-- celebration under its author's name. The Boss has since asked for the
-- simpler thing: ONE message, written by whichever of them gets to it, and
-- presented without attribution.
--
-- That removes the whole reason the two slots were role-locked. With no name
-- on the message there is nothing to misattribute, so achievement_set_message
-- stops caring which of them is calling and just writes the one column.
--
-- ── THIS IS NOT A CLEAN DROP ───────────────────────────────────────────────
-- Production already carries two drafts (APC and TL of the Month for 2026-08),
-- both with a message written into the OL slot. So the columns are backfilled
-- into `message` BEFORE they are dropped, and the verification below asserts
-- the text survived rather than assuming it did. Losing someone's typed line
-- to a schema tidy-up would be a poor trade for one fewer column.
--
-- coalesce(boss_message, ol_message) picks the Boss's line when both exist. In
-- the live rows only one is set either way, so nothing is actually discarded;
-- the order is just a rule that had to be chosen.
--
-- Idempotent.
-- ============================================================

-- ── 1. The single message ───────────────────────────────────────────────────
alter table public.achievements
  add column if not exists message    text,
  add column if not exists message_by uuid references public.profiles(id) on delete set null;

do $constraint$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.achievements'::regclass and conname = 'achievements_message_len'
  ) then
    alter table public.achievements
      add constraint achievements_message_len
      check (message is null or char_length(message) <= 100);
  end if;
end;
$constraint$;

-- ── 2. Carry the typed lines across before anything is dropped ──────────────
do $backfill$
declare
  v_moved int;
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'achievements' and column_name = 'boss_message'
  ) then
    update public.achievements
       set message    = coalesce(boss_message, ol_message),
           message_by = coalesce(boss_message_by, ol_message_by)
     where message is null
       and coalesce(boss_message, ol_message) is not null;   -- never a bare UPDATE
    get diagnostics v_moved = row_count;
    raise notice 'mig 354: carried % existing message(s) into the single column', v_moved;
  end if;
end;
$backfill$;

-- ── 3. The old slots ────────────────────────────────────────────────────────
-- After the backfill, and only after: dropping first would take the text with it.
alter table public.achievements
  drop column if exists boss_message,
  drop column if exists ol_message,
  drop column if exists boss_message_by,
  drop column if exists ol_message_by;

-- ── 4. Either of them writes it ─────────────────────────────────────────────
create or replace function public.achievement_set_message(p_id uuid, p_message text)
returns public.achievements
language plpgsql security definer set search_path = public
as $$
declare
  v_me     uuid := auth.uid();
  v_msg    text := nullif(btrim(coalesce(p_message, '')), '');
  v_status text;
  v_row    public.achievements;
begin
  if not public.can_manage_achievements(v_me) then
    raise exception 'only the Boss or an Operations Lead can write an achievement message';
  end if;
  if v_msg is not null and char_length(v_msg) > 100 then
    raise exception 'keep it to 100 characters — this one is %', char_length(v_msg);
  end if;

  select status into v_status from public.achievements where id = p_id;
  if not found then raise exception 'achievement not found'; end if;
  if v_status <> 'draft' then
    raise exception 'this achievement has already been announced — its message is fixed';
  end if;

  -- mig 354: no role branch any more. The message carries no byline, so either
  -- of them may write it and the last edit wins. message_by is still recorded —
  -- it is not displayed, but "who typed this" is worth being able to answer.
  update public.achievements
     set message    = v_msg,
         message_by = case when v_msg is null then null else v_me end
   where id = p_id
   returning * into v_row;

  return v_row;
end;
$$;

-- ── 5. Announce needs the one message ───────────────────────────────────────
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
  if v_row.message is null then
    raise exception 'write the message before announcing';
  end if;

  select label into v_label from public.achievement_types where key = v_row.type_key;

  -- The money, booked exactly once — incentive_item_id is the idempotency key,
  -- because announce stays callable until the winner acknowledges. Unchanged
  -- from mig 353; see its header for why it lands on the announcement month.
  if v_row.reward_amount > 0 and v_row.incentive_item_id is null then
    select * into v_inc from public.incentives
     where user_id = v_row.winner_id and month = v_month;

    if found and (v_inc.verified or v_inc.payout_cleared) then
      raise exception
        'the winner''s % incentives are already verified — un-verify that month before announcing, or the reward cannot be added',
        v_month;
    end if;

    if not found then
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

-- ── 6. The winner's payload loses the bylines ───────────────────────────────
create or replace function public.achievement_for_me()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_me      uuid := auth.uid();
  v_today   date := (now() at time zone 'Asia/Karachi')::date;
  v_pending jsonb;
  v_banner  jsonb;
begin
  if v_me is null then return jsonb_build_object('pending', null, 'banner', null); end if;

  select to_jsonb(x) into v_pending from (
    select a.id, a.month, a.reward_amount, a.message,
           t.label as type_label, t.blurb,
           public.profile_display_name(a.winner_id) as winner_name
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

-- ── 7. Verification ─────────────────────────────────────────────────────────
do $verify$
declare
  v_cnt   int;
  v_lost  int;
  v_boss  uuid;
  v_ol    uuid;
  v_id    uuid;
  v_type  text;
  v_msg   text;
  v_by    uuid;
begin
  -- The old slots are gone...
  select count(*) into v_cnt from information_schema.columns
   where table_schema = 'public' and table_name = 'achievements'
     and column_name in ('boss_message','ol_message','boss_message_by','ol_message_by');
  if v_cnt <> 0 then
    raise exception 'mig 354: % of the old message columns are still present', v_cnt;
  end if;

  -- ...and nothing that had a message lost it. Any draft whose author bothered
  -- to type a line must still have one.
  select count(*) into v_lost from public.achievements
   where message_by is not null and message is null;
  if v_lost <> 0 then
    raise exception 'mig 354: % row(s) kept an author but lost their message text', v_lost;
  end if;

  select count(*) into v_cnt from public.achievements where message is not null;
  raise notice 'mig 354: % achievement row(s) carry a message', v_cnt;

  -- Behavioural: the Boss and an OL must now write the SAME column. Done on a
  -- scratch row, impersonating through request.jwt.claims only — a `set local
  -- role` here would leave the session unable to record the migration (mig 351).
  select id into v_boss from public.profiles where role = 'boss' and is_active limit 1;
  select id into v_ol   from public.profiles where role = 'ol'   and is_active limit 1;
  select key into v_type from public.achievement_types limit 1;

  if v_boss is null or v_ol is null then
    raise notice 'mig 354: no Boss/OL pair to test with — single-slot behaviour UNVERIFIED';
    return;
  end if;

  begin
    insert into public.achievements (type_key, month, reward_amount)
    values (v_type, '1899-01', 0)
    returning id into v_id;

    perform set_config('request.jwt.claims',
      json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    perform public.achievement_set_message(v_id, 'boss wrote this');
    select message, message_by into v_msg, v_by from public.achievements where id = v_id;
    if v_msg <> 'boss wrote this' or v_by <> v_boss then
      raise exception 'mig 354: the Boss''s message did not land (% / %)', v_msg, v_by;
    end if;

    perform set_config('request.jwt.claims',
      json_build_object('sub', v_ol, 'role', 'authenticated')::text, true);
    perform public.achievement_set_message(v_id, 'ol overwrote it');
    select message, message_by into v_msg, v_by from public.achievements where id = v_id;
    if v_msg <> 'ol overwrote it' or v_by <> v_ol then
      raise exception 'mig 354: the OL did not write the same slot (% / %)', v_msg, v_by;
    end if;

    raise exception 'ROLLBACK_OK';        -- discards the scratch row
  exception when others then
    perform set_config('request.jwt.claims', '', true);
    if sqlerrm <> 'ROLLBACK_OK' then raise; end if;
  end;

  raise notice 'mig 354: one message, either of them writes it, no byline';
end;
$verify$;
