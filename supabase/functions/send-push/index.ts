// ============================================================
// Edge Function: send-push
//
// Invoked by the `notifications_dispatch_push_ai` trigger on
// each new row in `public.notifications`. Fetches the recipient's
// push subscriptions and sends a web-push to each.
//
// Env (set via `supabase secrets set`):
//   VAPID_PUBLIC_KEY
//   VAPID_PRIVATE_KEY
//   VAPID_SUBJECT           e.g. mailto:admin@wurxos.com
//   PUSH_WEBHOOK_SECRET     shared with app_config.send_push_secret
//   SUPABASE_URL            (auto)
//   SUPABASE_SERVICE_ROLE_KEY (auto)
//
// Deploy: supabase functions deploy send-push --no-verify-jwt
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import webpush from 'https://esm.sh/web-push@3.6.7';

const SUPABASE_URL           = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE            = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const VAPID_PUBLIC_KEY        = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE_KEY       = Deno.env.get('VAPID_PRIVATE_KEY')!;
const VAPID_SUBJECT           = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@example.com';
const PUSH_WEBHOOK_SECRET     = Deno.env.get('PUSH_WEBHOOK_SECRET') ?? '';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  // Shared-secret check (function is deployed with --no-verify-jwt)
  const provided = req.headers.get('x-webhook-secret') ?? '';
  if (!PUSH_WEBHOOK_SECRET || provided !== PUSH_WEBHOOK_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  const { notification_id } = await req.json().catch(() => ({}));
  if (!notification_id) return new Response('missing notification_id', { status: 400 });

  // Fetch the notification (including snooze_token so the SW can
  // call back into snooze-notification).
  const { data: note, error: nErr } = await admin
    .from('notifications')
    .select('id, recipient_id, title, body, category, action, link, snooze_token')
    .eq('id', notification_id)
    .single();
  if (nErr || !note) return new Response('notification not found', { status: 404 });

  // Fetch the recipient's subscriptions
  const { data: subs, error: sErr } = await admin
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .eq('user_id', note.recipient_id);
  if (sErr) return new Response('subs query failed', { status: 500 });
  if (!subs || subs.length === 0) return new Response('no subs', { status: 200 });

  // Embed absolute endpoints so the service worker doesn't have to
  // know the Supabase URL itself.
  const base       = SUPABASE_URL.replace(/\/$/, '');
  const snoozeUrl  = `${base}/functions/v1/snooze-notification`;
  const markReadUrl = `${base}/functions/v1/mark-notification-read`;
  const payload = JSON.stringify({
    title:          note.title,
    body:           note.body ?? '',
    link:           note.link ?? '/notifications',
    tag:            note.category,
    id:             note.id,
    snooze_token:   note.snooze_token,
    snooze_url:     snoozeUrl,
    mark_read_url:  markReadUrl,
  });

  const staleEndpoints: string[] = [];
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
      );
    } catch (err) {
      const status = (err as { statusCode?: number })?.statusCode;
      if (status === 404 || status === 410) staleEndpoints.push(s.endpoint);
    }
  }));

  if (staleEndpoints.length > 0) {
    await admin.from('push_subscriptions').delete().in('endpoint', staleEndpoints);
  }

  return new Response(JSON.stringify({ sent: subs.length - staleEndpoints.length, removed: staleEndpoints.length }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
