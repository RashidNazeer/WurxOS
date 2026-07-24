// Safe live test of the checkpoint return-log trigger (mig 268).
//
// Emits ZERO notifications: throwaway rows use author_id=null and the return
// transitions land on 'draft' (notifies author → null → guarded) — so
// emit_notification is never called and pg_net is never queued. Rows are
// INSERTed directly at their start status (INSERT doesn't fire the
// after-update-of-status trigger), transitioned once, inspected, then deleted
// (cascade clears the log).
import { sb } from '../migration/lib/supabase.js';

async function pickBrand() {
  const { data, error } = await sb.from('brands').select('id, brand_name').limit(1);
  if (error) throw error;
  if (!data.length) throw new Error('no brands to test against');
  return data[0];
}

async function insertCp(brandId, weekStart, status) {
  const { data, error } = await sb.from('weekly_checkpoints')
    .insert({ brand_id: brandId, week_start: weekStart, week_label: 'TEST', status, author_id: null, data: {} })
    .select('id, status').single();
  if (error) throw new Error(`insert(${status}): ${error.message}`);
  return data.id;
}
async function updateCp(id, patch) {
  const { error } = await sb.from('weekly_checkpoints').update(patch).eq('id', id);
  if (error) throw new Error(`update: ${error.message}`);
}
async function returns(id) {
  const { data, error } = await sb.from('checkpoint_returns')
    .select('from_status, to_status, note').eq('checkpoint_id', id).order('returned_at');
  if (error) throw error;
  return data;
}
async function del(id) { await sb.from('weekly_checkpoints').delete().eq('id', id); }

async function main() {
  const brand = await pickBrand();
  console.log(`Testing against brand: ${brand.brand_name}`);
  let pass = 0, fail = 0;
  const ok = (label, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label} ${extra}`); } };

  // ── Test A: TL→APC return (submitted → draft) captures the note atomically ──
  const a = await insertCp(brand.id, '2000-01-03', 'submitted');
  await updateCp(a, { status: 'draft', return_note: 'NOTE-A: fix the paid section', returned_at: new Date().toISOString() });
  const ra = await returns(a);
  ok('return logs exactly one row', ra.length === 1, `(got ${ra.length})`);
  ok('logs from=submitted to=draft', ra[0]?.from_status === 'submitted' && ra[0]?.to_status === 'draft');
  ok('captures the note in the SAME update', ra[0]?.note === 'NOTE-A: fix the paid section', `(got ${JSON.stringify(ra[0]?.note)})`);
  await del(a);

  // ── Test B: OL→TL return (verified → submitted) also logs with note ──
  const b = await insertCp(brand.id, '2000-01-10', 'verified');
  await updateCp(b, { status: 'submitted', return_note: 'NOTE-B: numbers off', returned_at: new Date().toISOString() });
  const rb = await returns(b);
  ok('verified→submitted logs one row with note', rb.length === 1 && rb[0]?.note === 'NOTE-B: numbers off', `(got ${JSON.stringify(rb)})`);
  await del(b);

  // ── Test C: reopen guard — approved → verified with NO note is NOT a return ──
  const c = await insertCp(brand.id, '2000-01-17', 'approved');
  await updateCp(c, { status: 'verified', return_note: null });
  const rc = await returns(c);
  ok('reopen (approved→verified, no note) logs NOTHING', rc.length === 0, `(got ${rc.length})`);
  await del(c);

  // ── Test D: content-only save does NOT change status (the autosave bug fix) ──
  const d = await insertCp(brand.id, '2000-01-24', 'submitted');
  await updateCp(d, { data: { edited: true }, updated_at: new Date().toISOString() }); // no status
  const { data: after } = await sb.from('weekly_checkpoints').select('status').eq('id', d).single();
  ok('content save keeps status=submitted (no silent revert)', after?.status === 'submitted', `(got ${after?.status})`);
  const rd = await returns(d);
  ok('content save logs no return', rd.length === 0, `(got ${rd.length})`);
  await del(d);

  // ── Confirm cleanup: no TEST rows linger ──
  const { data: leftovers } = await sb.from('weekly_checkpoints').select('id').eq('week_label', 'TEST');
  ok('all test rows cleaned up', (leftovers || []).length === 0, `(${(leftovers || []).length} left)`);

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error('ERROR:', e.message || e); process.exit(1); });
