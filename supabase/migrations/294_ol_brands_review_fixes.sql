-- ============================================================
-- 294 — OL incentive-brands: adversarial-review fixes (money correctness + safety)
--
-- A 12-finding review of migs 291-293 surfaced real issues. This migration fixes
-- the SQL half (frontend fixed alongside):
--
--  1. [CRITICAL] inc_reset_and_roll froze ONLY attendance items on the paid source
--     row — never ol_brands. mig 293's "rollover intentionally NOT touched" comment
--     reasoned about the carried-forward TARGET row and missed that reset-and-roll
--     ALSO freezes the SOURCE (paid) row. Result: an OL rolled via the end-of-month
--     Clear & Reset kept their "Brands hit GMV targets" item frozen at completed=false
--     (its stripped-at-rest state) forever -> UNDER-PAID. Fix: chain the ol_brands
--     freeze over the attendance freeze in the source-row UPDATE, exactly as mig 293
--     did for inc_clear_payout.
--
--  2. [MEDIUM] Brand<->TL-item match was a naked normalised-substring LIKE. A brand
--     whose name normalises to '' (punctuation-only) made `LIKE '%%'` -> matched ANY
--     completed item -> always "hit" -> inflated %/overpay. Fix: require the
--     normalised brand name to be >= 3 chars before it can match.
--
--  3. [LOW] The match scanned only the TL's `incentives` array; a GMV-target item
--     living in `bonuses` was invisible (the overlay + freeze already consider both).
--     Fix: scan incentives || bonuses in both RPCs.
--
--  4. [LOW/MEDIUM] Freeze `completed` used coalesce((target)::numeric, 70): an
--     explicit stored 0 stayed 0, so `pct >= 0` always completed — while the JS read
--     overlay uses `Number(target) || 70` (0 -> 70). Fix: nullif(...,0) so both agree.
--
--  5. [LOW] oib_write RLS allowed any authenticated user to plant self-scoped rows
--     (no OL-role check). Fix: require an active OL (Boss still bypasses).
--     ol_brand_incentive_status's bare `auth.uid() = p_ol` let a non-OL read via the
--     status RPC once rows were planted; tightened to active-OL-self OR Boss.
--
--  6. [MEDIUM] An OL could trim non-hitting brands from their own denominator to
--     inflate the %. Primary backstop stays Boss verification (the panel now shows the
--     denominator to the OL and the status RPC is Boss-viewable). Added defense: once
--     THIS month's OL incentive row is verified/paid, the set is locked (Boss bypass).
-- ============================================================

-- ------------------------------------------------------------
-- 1. Freeze helper — nullif(target,0) so 0 defaults to 70 like the JS overlay.
-- ------------------------------------------------------------
create or replace function public._inc_freeze_ol_brands_items(
  p_items jsonb, p_month text, p_user uuid
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_pct   numeric;
  v_final boolean := (p_month < to_char(now() at time zone 'Asia/Karachi', 'YYYY-MM'));
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or not exists (select 1 from jsonb_array_elements(p_items) e where e->>'source' = 'ol_brands') then
    return coalesce(p_items, '[]'::jsonb);
  end if;

  select b.pct into v_pct from public.ol_brand_incentive_pct(p_month, array[p_user]) b limit 1;
  v_pct := coalesce(v_pct, 0);

  return (
    select coalesce(jsonb_agg(
             case when e->>'source' = 'ol_brands'
                  then e || jsonb_build_object(
                         'achievedValue', v_pct,
                         'suffix',        coalesce(e->>'suffix', '%'),
                         -- nullif(...,0): an explicit 0 target means "unset" -> 70,
                         -- matching the JS read overlay's `Number(target) || 70`.
                         'completed',     v_final and (v_pct >= coalesce(nullif((e->>'targetValue')::numeric, 0), 70))
                       )
                  else e
             end order by ord
           ), '[]'::jsonb)
      from jsonb_array_elements(p_items) with ordinality as t(e, ord)
  );
end;
$$;
revoke execute on function public._inc_freeze_ol_brands_items(jsonb, text, uuid) from public, anon;
grant  execute on function public._inc_freeze_ol_brands_items(jsonb, text, uuid) to authenticated, service_role;

-- ------------------------------------------------------------
-- 2. ol_brand_incentive_pct — scan incentives||bonuses, >=3-char brand guard.
--    Gate (boss/ol/dev) preserved from mig 292.
-- ------------------------------------------------------------
create or replace function public.ol_brand_incentive_pct(p_month text, p_ol_ids uuid[])
returns table (ol_id uuid, hits int, total int, pct numeric)
language plpgsql security definer set search_path = public stable
as $$
begin
  if not (
    public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active)
  ) then return; end if;

  return query
    with sel as (
      select oib.ol_id, b.owner_id,
             regexp_replace(lower(b.brand_name), '[^a-z0-9]', '', 'g') as norm_brand
        from public.ol_incentive_brands oib
        join public.brands b on b.id = oib.brand_id and b.status = 'active'
       where oib.ol_id = any(p_ol_ids)
    ),
    hit as (
      select s.ol_id,
        (length(s.norm_brand) >= 3 and exists (
          select 1
            from public.incentives inc
            cross join lateral jsonb_array_elements(
              coalesce(inc.incentives,'[]'::jsonb) || coalesce(inc.bonuses,'[]'::jsonb)) it
           where inc.user_id = s.owner_id and inc.month = p_month
             and (it->>'completed')::boolean is true
             and regexp_replace(lower(coalesce(it->>'text','')), '[^a-z0-9]', '', 'g')
                 like '%' || s.norm_brand || '%'
        )) as is_hit
        from sel s
    )
    select h.ol_id,
           count(*) filter (where h.is_hit)::int,
           count(*)::int,
           case when count(*) > 0
                then round(count(*) filter (where h.is_hit)::numeric / count(*) * 100)
                else 0 end
      from hit h
     group by h.ol_id;
end;
$$;
revoke execute on function public.ol_brand_incentive_pct(text, uuid[]) from public, anon;
grant  execute on function public.ol_brand_incentive_pct(text, uuid[]) to authenticated;

-- ------------------------------------------------------------
-- 3. ol_brand_incentive_status — scan incentives||bonuses, >=3-char guard,
--    tightened gate (Boss any; active OL/dev only for THEMSELVES).
-- ------------------------------------------------------------
create or replace function public.ol_brand_incentive_status(p_ol uuid, p_month text)
returns table (brand_id uuid, brand_name text, client_name text, owner_name text, matched_text text, is_hit boolean)
language plpgsql security definer set search_path = public stable
as $$
begin
  if not (
    public.is_boss(auth.uid())
    or (p_ol = auth.uid()
        and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active))
  ) then return; end if;

  return query
    select b.id, b.brand_name, b.client_name, ow.display_name, m.text, coalesce(m.completed, false)
      from public.ol_incentive_brands oib
      join public.brands b on b.id = oib.brand_id and b.status = 'active'
      left join public.profiles ow on ow.id = b.owner_id
      left join lateral (
        select it->>'text' as text, (it->>'completed')::boolean as completed
          from public.incentives inc
          cross join lateral jsonb_array_elements(
            coalesce(inc.incentives,'[]'::jsonb) || coalesce(inc.bonuses,'[]'::jsonb)) it
         where inc.user_id = b.owner_id and inc.month = p_month
           and length(regexp_replace(lower(b.brand_name), '[^a-z0-9]', '', 'g')) >= 3
           and regexp_replace(lower(coalesce(it->>'text','')), '[^a-z0-9]', '', 'g')
               like '%' || regexp_replace(lower(b.brand_name), '[^a-z0-9]', '', 'g') || '%'
         order by (it->>'completed')::boolean desc nulls last
         limit 1
      ) m on true
     where oib.ol_id = p_ol
     order by b.brand_name;
end;
$$;
revoke execute on function public.ol_brand_incentive_status(uuid, text) from public, anon;
grant  execute on function public.ol_brand_incentive_status(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- 4. inc_reset_and_roll — VERBATIM from mig 256 plus the ol_brands freeze chained
--    onto the existing attendance freeze in the SOURCE (paid) row UPDATE. Both
--    helpers are no-ops when their item type is absent, so non-OL rows are
--    unaffected. (This is the CRITICAL fix — the primary month-end payout path.)
-- ------------------------------------------------------------
create or replace function public.inc_reset_and_roll(
  p_source text,
  p_target text,
  p_force_clear boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me      uuid := auth.uid();
  v_source  record;
  v_cleared int := 0;
  v_created int := 0;
  v_skipped int := 0;
  v_items   jsonb;
  v_bonuses jsonb;
  v_salary  numeric;
begin
  if not public.is_boss(v_me) then raise exception 'only Boss can reset & roll'; end if;
  if p_source is null or p_target is null then raise exception 'source & target month required'; end if;
  if p_source = p_target then raise exception 'source and target must differ'; end if;

  for v_source in select * from public.incentives where month = p_source loop
    -- Mark source row payout_cleared (if verified or forced) and FREEZE its
    -- attendance AND ol_brands items at the source-month figure (mig 256 + 294).
    if v_source.verified or p_force_clear then
      update public.incentives
         set payout_cleared    = true,
             payout_cleared_by = v_me,
             payout_cleared_at = now(),
             incentives        = public._inc_freeze_ol_brands_items(
                                    public._inc_freeze_attendance_items(incentives, month, user_id), month, user_id),
             bonuses           = public._inc_freeze_ol_brands_items(
                                    public._inc_freeze_attendance_items(bonuses,    month, user_id), month, user_id)
       where id = v_source.id;
      v_cleared := v_cleared + 1;
    else
      v_skipped := v_skipped + 1;
    end if;

    v_items := coalesce((
      select jsonb_agg(
        jsonb_set(
          jsonb_set(it::jsonb, '{achievedValue}', '0'::jsonb),
          '{completed}', 'false'::jsonb
        )
      )
      from jsonb_array_elements(v_source.incentives) it
    ), '[]'::jsonb);

    v_bonuses := coalesce((
      select jsonb_agg(
        jsonb_set(
          jsonb_set(it::jsonb, '{achievedValue}', '0'::jsonb),
          '{completed}', 'false'::jsonb
        )
      )
      from jsonb_array_elements(v_source.bonuses) it
    ), '[]'::jsonb);

    -- Salary source of truth = employee_compensation; fall back to the source
    -- month's snapshot when the user has no comp row yet (mig 189).
    select basic_salary into v_salary
      from public.employee_compensation
     where user_id = v_source.user_id;
    if v_salary is null then v_salary := v_source.basic_salary; end if;

    insert into public.incentives
      (user_id, month, basic_salary, incentives, bonuses, last_updated_by, updated_at)
    values
      (v_source.user_id, p_target, v_salary, v_items, v_bonuses, v_me, now())
    on conflict (user_id, month) do nothing;

    if found then v_created := v_created + 1; end if;
  end loop;

  return jsonb_build_object(
    'cleared', v_cleared,
    'created', v_created,
    'skipped', v_skipped
  );
end;
$$;
grant execute on function public.inc_reset_and_roll(text, text, boolean) to authenticated;

-- ------------------------------------------------------------
-- 5. oib_write RLS — require an active OL for self-writes (Boss bypasses).
-- ------------------------------------------------------------
drop policy if exists oib_write on public.ol_incentive_brands;
create policy oib_write on public.ol_incentive_brands for all
  using (public.is_boss(auth.uid())
    or (ol_id = auth.uid() and exists (
          select 1 from public.profiles p where p.id = auth.uid() and p.role = 'ol' and p.is_active)))
  with check (public.is_boss(auth.uid())
    or (ol_id = auth.uid() and exists (
          select 1 from public.profiles p where p.id = auth.uid() and p.role = 'ol' and p.is_active)));

-- ------------------------------------------------------------
-- 6. Lock the OL's brand set once THIS month's incentive row is verified/paid.
--    The set is month-agnostic, but only the CURRENT (unfrozen) month's row is
--    affected by an edit — past months are frozen in JSONB. So locking on the
--    current Karachi month's verified/paid state prevents post-verification
--    tampering with the denominator that decides the payout. Boss + service/
--    migration (null auth.uid()) bypass for corrections.
-- ------------------------------------------------------------
create or replace function public._oib_lock_after_verify()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_ol    uuid := coalesce(new.ol_id, old.ol_id);
  v_month text := to_char(now() at time zone 'Asia/Karachi', 'YYYY-MM');
begin
  if auth.uid() is null or public.is_boss(auth.uid()) then
    return coalesce(new, old);
  end if;
  if exists (
    select 1 from public.incentives i
     where i.user_id = v_ol and i.month = v_month
       and (i.verified or i.payout_cleared)
  ) then
    raise exception 'Your incentive brands are locked for % — this month''s incentive is already verified/paid. Ask the Boss to adjust.', v_month
      using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end;
$$;
drop trigger if exists oib_lock_after_verify on public.ol_incentive_brands;
create trigger oib_lock_after_verify
  before insert or update or delete on public.ol_incentive_brands
  for each row execute function public._oib_lock_after_verify();

-- ------------------------------------------------------------
-- Self-verification: confirm the critical rollover fix is in place.
-- ------------------------------------------------------------
do $$
declare v_src text;
begin
  select pg_get_functiondef('public.inc_reset_and_roll(text,text,boolean)'::regprocedure) into v_src;
  if position('_inc_freeze_ol_brands_items' in v_src) = 0 then
    raise exception 'FAIL: inc_reset_and_roll does not chain the ol_brands freeze';
  end if;
  raise notice 'OK: inc_reset_and_roll now freezes ol_brands on the paid source row.';
end $$;
