// ============================================================
// Edge Function: mark-notification-read
//
// Called by the service worker on the "Mark as read" push action.
// Authorizes by possession of the notification's one-time
// snooze_token (same mechanism as snooze-notification). The DB
// function rotates the token on use.
//
// Deploy: supabase functions deploy mark-notification-read --no-verify-jwt
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

  let body: { token?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const token = (body.token || '').trim();
  if (!token) return json({ error: 'token required' }, 400);

  const { data, error } = await admin.rpc('mark_notification_read_by_token', {
    p_token: token,
  });
  if (error) return json({ error: error.message }, 500);
  if (!data)  return json({ error: 'token not found' }, 404);

  return json({ ok: true, notification_id: data });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
