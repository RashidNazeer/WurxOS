// Supabase Edge Function: wipe-data
//
// Boss-only nuclear button. Two phases:
//
//   1. Calls the wipe_all_operational_data() RPC, which TRUNCATEs
//      every operational table (brands, tasks, reports, resources,
//      campaigns, broadcasts, chat, etc.) and returns a per-table
//      summary plus the caller's UUID.
//
//   2. Lists every auth user via admin.auth.admin.listUsers(),
//      then HARD-deletes every user EXCEPT the caller. The
//      operational data is already gone in step 1, so the
//      RESTRICT FKs that previously blocked deletion (brands.owner,
//      reports.author) no longer reference anyone — hard delete
//      now succeeds and the profile rows cascade away.
//
// The calling Boss is intentionally preserved so they don't lock
// themselves out and can keep using the system after the wipe.
//
// Deploy via CLI:   supabase functions deploy wipe-data

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST')    return json({ error: 'Method not allowed' }, 405);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const authHeader   = req.headers.get('Authorization') || '';
  const jwt          = authHeader.replace(/^Bearer\s+/i, '');

  if (!jwt) return json({ error: 'Missing Authorization header' }, 401);

  // userClient = caller's JWT, used to invoke the SECURITY DEFINER RPC
  // (which performs its own Boss check via auth.uid()).
  const userClient = createClient(SUPABASE_URL, SERVICE_ROLE, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data: { user }, error: userErr } = await userClient.auth.getUser(jwt);
  if (userErr || !user) return json({ error: 'Invalid session' }, 401);

  // Phase 1 — wipe operational data via the RPC.
  const { data: wipeRows, error: rpcErr } = await userClient.rpc('wipe_all_operational_data');
  if (rpcErr) return json({ error: rpcErr.message }, 400);

  const summary = (wipeRows || []) as Array<{ table_name: string; rows_before: number; caller_id: string }>;
  const callerId = summary[0]?.caller_id || user.id;

  // Phase 2 — hard-delete every auth user except the caller.
  // Use the admin client (service role) so we have privileges.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

  let deletedUsers = 0;
  let userErrors: Array<{ id: string; message: string }> = [];
  let page = 1;
  const perPage = 200;

  // listUsers paginates — walk every page until empty.
  while (true) {
    const { data, error: listErr } = await admin.auth.admin.listUsers({ page, perPage });
    if (listErr) {
      userErrors.push({ id: 'listUsers', message: listErr.message });
      break;
    }
    const users = data?.users || [];
    if (users.length === 0) break;

    for (const u of users) {
      if (u.id === callerId) continue;
      const { error: delErr } = await admin.auth.admin.deleteUser(u.id);
      if (delErr) {
        userErrors.push({ id: u.id, message: delErr.message });
      } else {
        deletedUsers++;
      }
    }

    if (users.length < perPage) break;
    page++;
  }

  return json({
    ok: true,
    summary,
    deletedUsers,
    callerId,
    userErrors: userErrors.length > 0 ? userErrors : undefined,
  }, 200);
});
