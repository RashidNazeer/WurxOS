import { sb } from './lib/supabase.js';

// Offboard Hamdan Khan (APC) — soft-delete the USER only, preserving all his
// historical data (reports, completed tasks, attendance, agenda history).
// His BRAND work transfers to Farakh Farooq:
//   * Squish Energy (inactive)  -> assigned to Farakh (he keeps Louisville Jerky => 2 brands)
//   * every BRAND task assigned to / created by Hamdan -> reassigned to Farakh
//     (non-brand tasks, e.g. report tasks, stay attributed to Hamdan as history)
//
// Soft-delete mirrors the delete-user Edge Function: auth.users soft-deleted
// (blocks login) + profiles.is_active=false/deleted_at set + membership rows
// removed (chat/pctl/kb/upvotes/brand_assignments). Historical attribution
// rows (reports.author_id, tasks.created_by/assignee_id we keep) are NOT touched.
//
// DRY RUN by default. Pass --apply to write.

const HAMDAN = '196364b5-1d80-5cb9-bc05-3a072ab54e08';
const FARAKH = '87cbdb86-c22a-5c17-9574-73fcb764b79e';
const SQUISH = '0454493a-9703-5766-9dd1-872bd4b05678';
const apply  = process.argv.includes('--apply');

async function pickActor() {
  const { data: boss } = await sb.from('profiles').select('id').eq('role', 'boss').eq('is_active', true).limit(1);
  if (boss?.length) return boss[0].id;
  const { data: ol } = await sb.from('profiles').select('id').eq('role', 'ol').eq('is_active', true).limit(1);
  return ol?.[0]?.id || null;
}

async function main() {
  console.log(apply ? '*** APPLY MODE — writes WILL happen ***\n' : 'DRY RUN — no writes. Re-run with --apply.\n');

  // ── Identity sanity checks ──────────────────────────────────
  const { data: ppl, error: pErr } = await sb
    .from('profiles').select('id, display_name, role, is_active, deleted_at')
    .in('id', [HAMDAN, FARAKH]);
  if (pErr) { console.error('profiles err', pErr.message); process.exitCode = 1; return; }
  const h = ppl.find((p) => p.id === HAMDAN);
  const f = ppl.find((p) => p.id === FARAKH);
  if (!h) { console.error('Hamdan not found — aborting.'); process.exitCode = 1; return; }
  if (!f) { console.error('Farakh not found — aborting.'); process.exitCode = 1; return; }
  if (h.role !== 'apc') { console.error(`Expected Hamdan role=apc, got ${h.role} — aborting.`); process.exitCode = 1; return; }
  if (h.deleted_at)     { console.error('Hamdan already deleted — aborting.'); process.exitCode = 1; return; }
  console.log(`Hamdan: ${h.display_name} (${h.role}) active=${h.is_active}`);
  console.log(`Farakh: ${f.display_name} (${f.role}) active=${f.is_active}\n`);

  // ── 1. Squish Energy -> Farakh ──────────────────────────────
  const { data: existing } = await sb.from('brand_assignments')
    .select('user_id').eq('brand_id', SQUISH).eq('user_id', FARAKH);
  const alreadyAssigned = (existing?.length || 0) > 0;
  console.log(`[1] Assign Squish Energy -> Farakh: ${alreadyAssigned ? 'already assigned (no-op)' : 'WILL insert assignment'}`);

  // ── 2. Brand tasks touching Hamdan -> Farakh ────────────────
  const { data: brandTasks } = await sb.from('tasks')
    .select('id, title, status, brand_id, assignee_id, created_by, brands:brand_id(brand_name)')
    .or(`assignee_id.eq.${HAMDAN},created_by.eq.${HAMDAN}`)
    .not('brand_id', 'is', null);
  console.log(`[2] Brand tasks to reassign to Farakh (${brandTasks?.length || 0}):`);
  for (const t of brandTasks || []) console.log(`      ${t.brands?.brand_name?.padEnd(18)} ${t.status.padEnd(6)} ${t.title}`);

  // Non-brand tasks that STAY (for transparency).
  const { data: stay } = await sb.from('tasks')
    .select('title, status').eq('assignee_id', HAMDAN).is('brand_id', null);
  console.log(`    Non-brand tasks staying with Hamdan (${stay?.length || 0}): ${(stay || []).map((t) => `${t.title}[${t.status}]`).join(', ')}`);

  // ── 3. Soft-delete cleanup preview ──────────────────────────
  const membershipTables = ['brand_assignments', 'pctl_brand_selections', 'chat_members', 'kb_acknowledgments', 'suggestion_upvotes'];
  console.log(`[3] Soft-delete Hamdan: auth soft-delete + profile is_active=false/deleted_at; purge membership rows (${membershipTables.join(', ')}); agenda schedules/upcoming meetings by tl_id (he is APC -> expect none). Reports & historical attribution preserved.`);

  if (!apply) {
    console.log('\nDry run complete. Re-run with --apply to execute.');
    return;
  }

  const actor = await pickActor();
  console.log(`\n--- APPLYING (audit actor=${actor}) ---`);

  // 1. Assign Squish to Farakh.
  if (!alreadyAssigned) {
    const { error } = await sb.from('brand_assignments')
      .insert({ brand_id: SQUISH, user_id: FARAKH, assigned_by: actor, assigned_at: new Date().toISOString() });
    console.log(`  [1] Squish -> Farakh: ${error ? 'ERROR ' + error.message : 'assigned'}`);
  } else console.log('  [1] Squish already assigned to Farakh — skipped.');

  // 2. Reassign brand tasks to Farakh (assignee only; created_by/authorship preserved).
  const { data: moved, error: tErr } = await sb.from('tasks')
    .update({ assignee_id: FARAKH, updated_at: new Date().toISOString() })
    .or(`assignee_id.eq.${HAMDAN},created_by.eq.${HAMDAN}`)
    .not('brand_id', 'is', null)
    .select('id');
  console.log(`  [2] Brand tasks reassigned: ${tErr ? 'ERROR ' + tErr.message : (moved?.length || 0)}`);

  // 3a. Soft-delete the auth user (blocks login; keeps the row -> FKs intact).
  const { error: authErr } = await sb.auth.admin.deleteUser(HAMDAN, true);
  console.log(`  [3] auth soft-delete: ${authErr ? 'ERROR ' + authErr.message : 'done'}`);

  // 3b. Mirror on the profile.
  const { error: profErr } = await sb.from('profiles')
    .update({ is_active: false, deleted_at: new Date().toISOString() }).eq('id', HAMDAN);
  console.log(`  [3] profile is_active=false/deleted_at: ${profErr ? 'ERROR ' + profErr.message : 'done'}`);

  // 3c. Purge membership rows.
  for (const t of membershipTables) {
    const { error } = await sb.from(t).delete().eq('user_id', HAMDAN);
    console.log(`      purge ${t}: ${error ? 'ERR ' + error.message : 'ok'}`);
  }
  // Agenda by tl_id (APC -> none expected).
  await sb.from('agenda_team_schedules').delete().eq('tl_id', HAMDAN);
  await sb.from('agenda_meetings').delete().eq('tl_id', HAMDAN).in('status', ['upcoming', 'ongoing']);

  // Audit (best-effort).
  if (actor) {
    await sb.from('audit_log').insert({
      actor_id: actor, action: 'user.offboard', entity_type: 'profiles', entity_id: HAMDAN,
      before: { display_name: h.display_name, role: h.role },
      after: { soft_deleted: true, brand_assigned_to_farakh: 'Squish Energy', brand_tasks_reassigned: moved?.length || 0 },
    });
  }

  // ── Verify ─────────────────────────────────────────────────
  console.log('\n--- VERIFY ---');
  const { data: hp } = await sb.from('profiles').select('is_active, deleted_at').eq('id', HAMDAN).maybeSingle();
  console.log(`  Hamdan profile: is_active=${hp?.is_active} deleted_at=${hp?.deleted_at ? 'set' : 'NULL'}`);
  const { data: fb } = await sb.from('brand_assignments').select('brands:brand_id(brand_name, status)').eq('user_id', FARAKH);
  console.log(`  Farakh brands now: ${(fb || []).map((x) => `${x.brands?.brand_name}[${x.brands?.status}]`).join(', ')}`);
  const { data: leftover } = await sb.from('tasks').select('id, brand_id').eq('assignee_id', HAMDAN).not('brand_id', 'is', null);
  console.log(`  Hamdan leftover BRAND tasks (should be 0): ${leftover?.length || 0}`);
  const { data: kept } = await sb.from('tasks').select('title').eq('assignee_id', HAMDAN);
  console.log(`  Tasks still attributed to Hamdan (non-brand history, expected 2): ${(kept || []).map((t) => t.title).join(', ')}`);
}

main();
