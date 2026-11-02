-- ============================================================
-- WurxOS v2 — Migration 433: a standard reward per award.
--
-- APC of the Month pays PKR 10,000 and TL of the Month PKR 15,000 (every award so
-- far was booked at those amounts), but the app kept no standard: the reward box
-- started empty with the same "e.g. 10000" hint on BOTH cards, and a winner saved
-- without typing a reward was stored at 0, which pays nothing when announced.
--
--   achievement_types.default_reward   the standard amount for that award
--   achievement_upsert                 a reward that is not supplied (null) takes
--                                      the standard; an explicit 0 still means
--                                      "recognition only"
--   unannounced drafts left at 0       take the standard (announced/acknowledged
--                                      awards, and anything already paid, are
--                                      never touched)
-- Idempotent.
-- ============================================================

alter table public.achievement_types
  add column if not exists default_reward numeric not null default 0;
alter table public.achievement_types drop constraint if exists achievement_types_default_reward_check;
alter table public.achievement_types
  add constraint achievement_types_default_reward_check check (default_reward >= 0);

update public.achievement_types set default_reward = 10000 where key = 'apc_of_the_month';
update public.achievement_types set default_reward = 15000 where key = 'tl_of_the_month';

create or replace function public.achievement_upsert(p_type_key text, p_month text, p_winner_id uuid, p_reward numeric)
 returns achievements
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_me    uuid := auth.uid();
  v_roles text[];
  v_role  text;
  v_std   numeric;
  v_row   public.achievements;
begin
  if not public.can_manage_achievements(v_me) then
    raise exception 'only the Boss or an Operations Lead can manage achievements';
  end if;
  if p_month !~ '^\d{4}-\d{2}$' then
    raise exception 'month must look like YYYY-MM';
  end if;

  select eligible_roles, default_reward into v_roles, v_std from public.achievement_types where key = p_type_key;
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
  values (p_type_key, p_month, p_winner_id, coalesce(p_reward, v_std, 0), v_me)
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
$function$;

-- Drafts that were saved without a reward sit at 0. Give them the standard.
update public.achievements a
   set reward_amount = t.default_reward
  from public.achievement_types t
 where t.key = a.type_key
   and a.status = 'draft'
   and a.reward_amount = 0
   and a.incentive_item_id is null
   and t.default_reward > 0;

do $verify$
declare v_apc numeric; v_tl numeric;
begin
  select default_reward into v_apc from public.achievement_types where key = 'apc_of_the_month';
  select default_reward into v_tl  from public.achievement_types where key = 'tl_of_the_month';
  if v_apc <> 10000 or v_tl <> 15000 then
    raise exception 'mig 433: standard rewards are % / %, expected 10000 / 15000', v_apc, v_tl;
  end if;
  if position('v_std' in pg_get_functiondef('public.achievement_upsert(text,text,uuid,numeric)'::regprocedure)) = 0 then
    raise exception 'mig 433: achievement_upsert was not updated';
  end if;
end;
$verify$;
