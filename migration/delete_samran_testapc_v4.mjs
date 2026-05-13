// Final pass for Samran + Test APC. Handles reports (the blocker FK).
//   * Samran's 6 reports → reassign author_id to Muhammd Azam
//   * Test APC's 4 reports → delete
// Then retry auth.admin.deleteUser.

import { sb } from './lib/supabase.js';

const SAMRAN_ID  = '38c1b000-292b-55a0-b5d0-7ada6a8e6317';
const TESTAPC_ID = '80f41dbf-9478-5036-8976-9ed7b6cbff02';
const AZAM_ID    = 'a3cbbb8e-d671-5c81-8379-c34f2166a83f';

// 1. Samran's reports → Azam
const { data: reass, error: rErr } = await sb
  .from('reports')
  .update({ author_id: AZAM_ID })
  .eq('author_id', SAMRAN_ID)
  .select('id');
if (rErr) { console.log('Samran reports reassign ERR:', rErr.message); process.exit(1); }
console.log(`Samran reports reassigned to Azam: ${reass?.length || 0}`);

// 2. Test APC's reports → delete
const { data: tDel, error: tErr } = await sb
  .from('reports').delete().eq('author_id', TESTAPC_ID).select('id');
if (tErr) console.log('Test APC reports del ERR:', tErr.message);
else console.log(`Test APC reports deleted: ${tDel?.length || 0}`);

// 3. Final auth delete
for (const [name, id] of [['Samran', SAMRAN_ID], ['Test APC', TESTAPC_ID]]) {
  console.log(`\n--- delete ${name} ---`);
  const { error: dErr } = await sb.auth.admin.deleteUser(id);
  if (dErr) {
    console.log(`  auth.admin.deleteUser ERR: ${dErr.message}`);
    continue;
  }
  console.log('  auth user deleted ✓');
  const { data: prof } = await sb
    .from('profiles').select('id, display_name').eq('id', id).maybeSingle();
  console.log(prof
    ? `  ⚠ profile still present: ${prof.display_name}`
    : '  profile row gone ✓');
}
