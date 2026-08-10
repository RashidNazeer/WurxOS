// Supabase Edge Function: create-user
//
// Boss-only admin endpoint that creates a new auth user with a password.
// Honors role-specific extras:
//   * TL   — permissions: { canAddAPC, canAddBrand, canManageIncentives }
//   * PCTL — permissions: { canAddIPC, canAddBrand }
//   * APC  — reports_to (required): a TL profile id
//   * IPC  — reports_to (required): a PCTL profile id
//   * ADS_MANAGER — no parent, no permission flags. Which brands they run ads
//     for is set afterwards by an OL in Settings → Ads Manager Brands
//     (ads_manager_brands, mig 316) — that list is also what they can SEE.
//
// The profile row is inserted by the `handle_new_user` trigger which
// reads all of these from user_metadata.
//
// Deploy via CLI:   supabase functions deploy create-user
// Or paste into the dashboard Edge Functions editor.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const ALLOWED_ROLES = ['ol', 'tl', 'pctl', 'apc', 'ipc', 'ads_manager', 'developer'];
const REPORTS_TO_EXPECT: Record<string, string> = { apc: 'tl', ipc: 'pctl' };

const PERMISSION_KEYS: Record<string, string[]> = {
  tl:   ['canAddAPC', 'canAddBrand', 'canManageIncentives'],
  pctl: ['canAddIPC', 'canAddBrand'],
  apc:  ['canManageTasks'],
  ipc:  ['canManageTasks'],
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function sanitizePermissions(role: string, raw: unknown): Record<string, boolean> {
  const keys = PERMISSION_KEYS[role] || [];
  const out: Record<string, boolean> = {};
  if (!keys.length) return out;
  const src = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
  for (const k of keys) out[k] = Boolean(src[k]);
  return out;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST')    return json({ error: 'Method not allowed' }, 405);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const authHeader   = req.headers.get('Authorization') || '';
  const jwt          = authHeader.replace(/^Bearer\s+/i, '');

  if (!jwt) return json({ error: 'Missing Authorization header' }, 401);

  const userClient = createClient(SUPABASE_URL, SERVICE_ROLE, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data: { user }, error: userErr } = await userClient.auth.getUser(jwt);
  if (userErr || !user) return json({ error: 'Invalid session' }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

  // Verify caller. Boss can create anyone; a PCTL with canAddIPC can
  // create IPCs that report to themselves (delegated onboarding).
  const { data: caller, error: callerErr } = await admin
    .from('profiles')
    .select('id, role, is_active, permissions')
    .eq('id', user.id)
    .maybeSingle();
  if (callerErr) return json({ error: callerErr.message }, 500);
  if (!caller || !caller.is_active) {
    return json({ error: 'Forbidden' }, 403);
  }
  const isBoss = caller.role === 'boss';
  const isPctlAddingIpc =
    caller.role === 'pctl' &&
    (caller.permissions as Record<string, unknown> | null)?.canAddIPC === true;
  const isTlAddingApc =
    caller.role === 'tl' &&
    (caller.permissions as Record<string, unknown> | null)?.canAddAPC === true;

  // Parse payload
  let body: {
    email?: string;
    password?: string;
    displayName?: string;
    role?: string;
    reportsTo?: string | null;
    permissions?: Record<string, unknown>;
    responsibilities?: string[];
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const email       = (body.email || '').trim().toLowerCase();
  const password    = body.password || '';
  const displayName = (body.displayName || '').trim();
  const role        = (body.role || '').trim();
  let   reportsTo   = body.reportsTo || null;
  const permissions = sanitizePermissions(role, body.permissions);

  // Authorization: Boss can do anything; PCTL (with canAddIPC) can
  // create IPCs that report to themselves; TL (with canAddAPC) can
  // create APCs that report to themselves.
  if (!isBoss) {
    if (isPctlAddingIpc && role === 'ipc') {
      reportsTo = caller.id;
    } else if (isTlAddingApc && role === 'apc') {
      reportsTo = caller.id;
    } else {
      return json({ error: 'Forbidden' }, 403);
    }
  }

  if (!email)       return json({ error: 'Email is required' }, 400);
  if (!displayName) return json({ error: 'Display name is required' }, 400);
  if (password.length < 8) return json({ error: 'Password must be at least 8 characters' }, 400);
  if (!ALLOWED_ROLES.includes(role)) {
    return json({ error: `Role must be one of: ${ALLOWED_ROLES.join(', ')}` }, 400);
  }

  // Validate reports_to when required (APC → TL, IPC → PCTL)
  const expectedParentRole = REPORTS_TO_EXPECT[role];
  if (expectedParentRole) {
    if (!reportsTo) {
      return json({ error: `${role.toUpperCase()} must be assigned to a ${expectedParentRole.toUpperCase()}.` }, 400);
    }
    const { data: parent, error: parentErr } = await admin
      .from('profiles')
      .select('id, role, is_active')
      .eq('id', reportsTo)
      .maybeSingle();
    if (parentErr)  return json({ error: parentErr.message }, 500);
    if (!parent)    return json({ error: 'Assigned parent user not found.' }, 400);
    if (parent.role !== expectedParentRole || !parent.is_active) {
      return json({ error: `Assigned parent must be an active ${expectedParentRole.toUpperCase()}.` }, 400);
    }
  }

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      display_name: displayName,
      role,
      created_by: user.id,
      reports_to: reportsTo,
      permissions,
      responsibilities: Array.isArray(body.responsibilities)
        ? body.responsibilities.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20)
        : [],
    },
  });
  if (createErr) return json({ error: createErr.message }, 400);

  const { data: profile } = await admin
    .from('profiles')
    .select('*')
    .eq('id', created.user.id)
    .maybeSingle();

  return json({ user: created.user, profile }, 200);
});
