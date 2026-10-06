-- ============================================================
-- WurxOS v2 — Migration 365: only database code can create notifications.
--
-- public.emit_notification (migration 011) is SECURITY DEFINER and inserts a
-- notification for ANY recipient with ANY title, body and link. No migration
-- ever limited who may call it, so Supabase's default grants left EXECUTE with
-- PUBLIC, anon and authenticated. Checked on prod 2026-09-16: a logged-out
-- visitor could call it through the REST API and send anyone a notification
-- (and a phone push) with a link of their choosing.
--
-- Nothing legitimate calls it from outside the database:
--   * all 70 functions that call it are SECURITY DEFINER owned by postgres,
--     so they run as the owner and keep working;
--   * no page, edge function or cron job calls it directly;
--   * service_role keeps EXECUTE for server-side scripts.
--
-- The token-authorised snooze / mark-read functions the service worker uses
-- (snooze_notification_by_token, mark_notification_read_by_token) are separate
-- and deliberately stay callable without a login.
--
-- anon is revoked BY NAME: revoking from PUBLIC does not remove Supabase's
-- explicit grant (see migration 348).
-- ============================================================

revoke all on function public.emit_notification(uuid, uuid, text, text, text, text, text, uuid, text) from public;
revoke all on function public.emit_notification(uuid, uuid, text, text, text, text, text, uuid, text) from anon;
revoke all on function public.emit_notification(uuid, uuid, text, text, text, text, text, uuid, text) from authenticated;
grant execute on function public.emit_notification(uuid, uuid, text, text, text, text, text, uuid, text) to service_role;

do $v$
declare
  sig constant text := 'public.emit_notification(uuid, uuid, text, text, text, text, text, uuid, text)';
begin
  if has_function_privilege('anon', sig, 'EXECUTE') then
    raise exception '365: logged-out visitors can still create notifications';
  end if;
  if has_function_privilege('authenticated', sig, 'EXECUTE') then
    raise exception '365: signed-in users can still call emit_notification directly';
  end if;
  if not has_function_privilege('service_role', sig, 'EXECUTE') then
    raise exception '365: service_role lost emit_notification';
  end if;
  if exists (
    select 1 from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.prosrc ilike '%emit_notification%'
       and p.proname <> 'emit_notification'
       and (not p.prosecdef or pg_get_userbyid(p.proowner) <> 'postgres')
  ) then
    raise exception '365: a caller of emit_notification would lose access (not SECURITY DEFINER owned by postgres)';
  end if;
  raise notice '365: emit_notification is callable only from database code and service_role';
end;
$v$;
