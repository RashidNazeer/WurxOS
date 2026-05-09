-- ============================================================
-- Migration 127 — Allow editing the note on a roster adjustment.
--
-- v1 supports updating an adjustment's note ("rename a manager
-- backfill comment without dropping the date"). v2's
-- attendance_adjustments table forbids direct writes (mig 119
-- only allows mutations through SECURITY DEFINER RPCs), so we
-- need a dedicated RPC. Permission gate matches the create/delete
-- gate — Boss / OL (not self / not other OLs) / Developer.
-- ============================================================

create or replace function public.att_adjust_update_note(
  p_user_id uuid,
  p_date    date,
  p_note    text
) returns public.attendance_adjustments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id    uuid := auth.uid();
  v_actor_role  text;
  v_target_role text;
  v_row         public.attendance_adjustments;
begin
  if v_actor_id is null then raise exception 'not authenticated'; end if;

  select role into v_actor_role from public.profiles where id = v_actor_id;
  select role into v_target_role from public.profiles where id = p_user_id;
  if v_target_role is null then raise exception 'user not found'; end if;

  if not public._adjust_can_act(v_actor_id, v_actor_role, p_user_id, v_target_role) then
    raise exception 'not authorised to adjust this user';
  end if;

  update public.attendance_adjustments
     set note = nullif(trim(coalesce(p_note,'')), '')
   where user_id = p_user_id and date = p_date
   returning * into v_row;

  return v_row;
end;
$$;
grant execute on function public.att_adjust_update_note(uuid, date, text) to authenticated;
