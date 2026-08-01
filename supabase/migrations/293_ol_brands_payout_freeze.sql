-- ============================================================
-- 293 — Freeze OL-brands items at payout (money correctness).
--
-- source='ol_brands' items are read-time-derived (achievedValue overlaid from the
-- brand roll-up %, stripped to null at rest — like attendance). So at payout-clear
-- their at-rest value is null and the OL's incentive would freeze as NOT earned.
-- Mirror _inc_freeze_attendance_items: snapshot the live % + completed into the
-- JSONB when the payout is turned on. completed uses the item's OWN target (70),
-- money-gated to a CLOSED month (same isFinalMonth rule as the read overlay).
--
-- Rollover (inc_reset_and_roll) is intentionally NOT touched: a carried-forward
-- ol_brands item is harmless because BOTH the read overlay AND this freeze
-- recompute the % fresh for the target month, and saving strips it.
-- ============================================================
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
                         'completed',     v_final and (v_pct >= coalesce((e->>'targetValue')::numeric, 70))
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

-- inc_clear_payout — VERBATIM from mig 256 plus the ol_brands freeze chained onto
-- the existing attendance freeze (both are no-ops when their item type is absent).
create or replace function public.inc_clear_payout(p_id uuid, p_cleared boolean)
returns public.incentives
language plpgsql security definer set search_path = public
as $$
declare
  v_me  uuid := auth.uid();
  v_row public.incentives;
begin
  if not (public.is_boss(v_me) or exists (
    select 1 from public.profiles p where p.id = v_me and p.role in ('ol','developer') and p.is_active = true
  )) then raise exception 'only Boss/OL can clear payout'; end if;

  update public.incentives
     set payout_cleared = p_cleared
   where id = p_id
   returning * into v_row;
  if not found then raise exception 'incentives row not found'; end if;

  -- FREEZE on turn-on: snapshot attendance % AND ol-brands % into the JSONB.
  if p_cleared then
    update public.incentives
       set incentives = public._inc_freeze_ol_brands_items(
                          public._inc_freeze_attendance_items(incentives, month, user_id), month, user_id),
           bonuses    = public._inc_freeze_ol_brands_items(
                          public._inc_freeze_attendance_items(bonuses,    month, user_id), month, user_id)
     where id = p_id
     returning * into v_row;
  end if;

  if p_cleared then
    perform public.emit_notification(
      v_row.user_id, v_me, 'system', 'incentives.paid',
      'Payout cleared',
      'Your ' || v_row.month || ' payout has been cleared.',
      'incentives', v_row.id, '/incentives'
    );
  end if;

  return v_row;
end;
$$;
grant execute on function public.inc_clear_payout(uuid, boolean) to authenticated;
