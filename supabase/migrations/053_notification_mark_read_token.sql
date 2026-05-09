-- ============================================================
-- WurxOS v2 — Migration 053: mark-as-read via push token
--
-- Lets the service worker mark a notification as read when the
-- user clicks the "Mark as read" action on a push popup. The SW
-- has no JWT, so we authorize by possession of the same one-time
-- snooze_token baked into the push payload (migration 047). The
-- token rotates on use so it can't be replayed.
-- ============================================================

create or replace function public.mark_notification_read_by_token(
  p_token uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  update public.notifications
    set read_at      = coalesce(read_at, now()),
        snooze_token = gen_random_uuid()
    where snooze_token = p_token
    returning id into v_id;
  return v_id;
end;
$$;
grant execute on function public.mark_notification_read_by_token(uuid) to anon, authenticated, service_role;
