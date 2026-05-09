// ============================================================
// Edge Function: snooze-notification
//
// Called by the service worker when a user clicks "Snooze 10 min"
// on a web-push notification. The SW has no JWT, so we authorize
// by possession of the one-time `snooze_token` embedded in the
// push payload. The DB function rotates the token on snooze so
// a stale SW can't re-snooze the same notification repeatedly.
//
// Deploy: supabase functions deploy snooze-notification --no-verify-jwt
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')    return new Response('Method not allowed', { status: 405, headers: CORS });

  let body: { token?: string; minutes?: number };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const token   = (body.token || '').trim();
  const minutes = Number.isFinite(body.minutes) ? Number(body.minutes) : 10;
  if (!token)   return json({ error: 'token required' }, 400);

  const { data, error } = await admin.rpc('snooze_notification_by_token', {
    p_token:   token,
    p_minutes: minutes,
  });
  if (error) return json({ error: error.message }, 500);
  if (!data)  return json({ error: 'token not found' }, 404);

  return json({ ok: true, notification_id: data, minutes });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
