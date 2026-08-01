-- ============================================================
-- 283 — Creator Library: tighten who can send "Creators need review" nudges.
--
-- creator_notify_pending (mig 282) gated the caller only by can_view_brand, which
-- returns true for a PCTL on EVERY brand — but the PCTL is view-only and must not
-- fire review notifications. Restrict the caller to a legitimate notifier:
-- OL/Boss, the brand's owner TL, or an IPC assigned to the brand.
-- ============================================================
create or replace function public.creator_notify_pending(p_brand uuid, p_message text default null)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_me    uuid := auth.uid();
  v_owner uuid;
  v_brand text;
  v_body  text;
  v_n     integer := 0;
  r       record;
begin
  select owner_id, brand_name into v_owner, v_brand from public.brands where id = p_brand;
  if not found then raise exception 'brand not found'; end if;

  if not (
    public.is_boss(v_me)
    or exists (select 1 from public.profiles p where p.id = v_me and p.role = 'ol' and p.is_active)
    or (v_owner = v_me and exists (select 1 from public.profiles p where p.id = v_me and p.role = 'tl' and p.is_active))
    or exists (select 1 from public.brand_assignments ba join public.profiles p on p.id = ba.user_id
               where ba.brand_id = p_brand and ba.user_id = v_me and p.role = 'ipc' and p.is_active)
  ) then raise exception 'not allowed to notify for this brand'; end if;

  v_body := 'Please review the creator library for ' || coalesce(v_brand, 'this brand')
    || coalesce(' — ' || nullif(trim(p_message), ''), '');

  for r in
    select p.id from public.profiles p
    where p.is_active and p.id <> v_me and (p.id = v_owner or p.role = 'ol')
  loop
    perform public.emit_notification(r.id, v_me, 'creator_library', 'creator_library.review',
      'Creators need review', v_body, 'brand', p_brand, '/creator-library?brand=' || p_brand);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;
