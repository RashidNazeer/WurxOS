// Supabase Edge Function: delete-user
//
// Boss-only admin endpoint that soft-deletes a user.
// Hard-delete won't work because some FKs use ON DELETE RESTRICT
// (brands.owner_id, reports.author_id) — owning a brand or having
// authored a report would block the cascade. Soft delete keeps
// historical data intact while preventing future sign-ins:
//
//   1. admin.auth.admin.deleteUser(id, /*shouldSoftDelete*/ true)
//      Marks auth.users.deleted_at — Supabase auth then rejects
//      any sign-in attempt for that account.
//   2. Mark the profile: is_active = false, deleted_at = now().
//      The UI filters deleted_at IS NOT NULL out of management
//      lists so the user disappears from APC/IPC/TL/etc. pages.
//
// Guards:
//   * Caller must be an active Boss.
//   * Cannot delete self.
//   * Cannot delete another Boss account.
//
// Deploy via CLI:   supabase functions deploy delete-user

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

  const userClient = createClient(SUPABASE_URL, SERVICE_ROLE, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data: { user }, error: userErr } = await userClient.auth.getUser(jwt);
  if (userErr || !user) return json({ error: 'Invalid session' }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

  const { data: caller, error: callerErr } = await admin
    .from('profiles')
    .select('id, role, is_active')
    .eq('id', user.id)
    .maybeSingle();
  if (callerErr) return json({ error: callerErr.message }, 500);
  if (!caller || !caller.is_active || caller.role !== 'boss') {
    return json({ error: 'Forbidden' }, 403);
  }

  let body: { userId?: string };
  try { body = await req.json(); }
  catch { return json({ error: 'Invalid JSON body' }, 400); }

  const targetId = (body.userId || '').trim();
  if (!targetId) return json({ error: 'userId is required' }, 400);
  if (targetId === user.id) return json({ error: 'You cannot delete your own account.' }, 400);

  const { data: target, error: targetErr } = await admin
    .from('profiles')
    .select('id, role, display_name, email')
    .eq('id', targetId)
    .maybeSingle();
  if (targetErr) return json({ error: targetErr.message }, 500);
  if (!target)   return json({ error: 'User not found.' }, 404);
  if (target.role === 'boss') {
    return json({ error: 'Boss accounts cannot be deleted from here.' }, 400);
  }

  // Soft-delete the auth user (the second arg is shouldSoftDelete).
  // This sets auth.users.deleted_at so login attempts are rejected,
  // but doesn't physically remove the row — keeping FKs intact.
  const { error: delErr } = await admin.auth.admin.deleteUser(targetId, true);
  if (delErr) return json({ error: delErr.message }, 400);

  // Mirror the deletion on the profile so the UI can hide them.
  const { error: profileErr } = await admin
    .from('profiles')
    .update({ is_active: false, deleted_at: new Date().toISOString() })
    .eq('id', targetId);
  if (profileErr) return json({ error: profileErr.message }, 500);

  // Hard-remove membership / assignment rows so the user vanishes from
  // brand teams, paid-collab selections, chat channels, and approver
  // lists. We keep the rows that *attribute* historical work (created_by,
  // author_id, assignee_id on tasks/reports/etc.) — those are FK-protected
  // and the user's contributions should remain visible.
  const cleanupTables = [
    'brand_assignments',         // ← the bug being fixed
    'pctl_brand_selections',     // PCTL's selected brand list
    'chat_members',              // chat membership
    'kb_acknowledgments',        // their ack rows on KB
    'suggestion_upvotes',        // their upvotes
  ] as const;

  const cleanupResults: Record<string, string | null> = {};
  for (const t of cleanupTables) {
    const { error } = await admin.from(t).delete().eq('user_id', targetId);
    cleanupResults[t] = error ? error.message : null;
  }

  // Agenda meetings are keyed by tl_id (not user_id). Soft-delete means the
  // ON DELETE CASCADE on these FKs never fires, so a deleted TL would keep a
  // lingering meeting schedule that agenda_notify_week re-materialises every
  // week (a ghost "0 APCs" card). Drop the schedule + any upcoming/ongoing
  // meeting; completed meetings stay for history (child rows cascade, mig 179).
  {
    const { error: agSchedErr } = await admin
      .from('agenda_team_schedules')
      .delete()
      .eq('tl_id', targetId);
    cleanupResults['agenda_team_schedules'] = agSchedErr ? agSchedErr.message : null;

    const { error: agMeetErr } = await admin
      .from('agenda_meetings')
      .delete()
      .eq('tl_id', targetId)
      .in('status', ['upcoming', 'ongoing']);
    cleanupResults['agenda_meetings'] = agMeetErr ? agMeetErr.message : null;
  }

  // Reassign brand ownership: a deleted user can't own a brand. Hand
  // every owned brand to the caller (the Boss who triggered the
  // delete). The brand-owner trigger (mig 025) blocks owner_id
  // changes by non-Boss callers; admin_reassign_orphaned_brands
  // (mig 190) sets the bypass GUC inside its own transaction so the
  // trigger lets the update through. Bonus: the cascade trigger
  // added in mig 190 will also fix up reports_to for any single-
  // brand APC assigned to those brands.
  const { data: reassignedCount, error: reassignErr } = await admin
    .rpc('admin_reassign_orphaned_brands', {
      p_orphan: targetId,
      p_new_owner: user.id,
    });
  cleanupResults['brands_reassigned'] =
    reassignErr ? reassignErr.message : String(reassignedCount ?? 0);

  return json({
    ok: true,
    deleted: { id: target.id, email: target.email, displayName: target.display_name },
    cleanup: cleanupResults,
  }, 200);
});
