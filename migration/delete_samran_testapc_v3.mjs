// Round-3: reassign Samran's resources to his TL (Muhammd Azam),
// delete Test APC's single resource, then retry the user delete.

import { sb } from './lib/supabase.js';

const SAMRAN_ID   = '38c1b000-292b-55a0-b5d0-7ada6a8e6317';
const TESTAPC_ID  = '80f41dbf-9478-5036-8976-9ed7b6cbff02';

// 1. Find Muhammd Azam's profile id (Samran's TL).
const { data: azamRows } = await sb
  .from('profiles')
  .select('id, display_name, role')
  .ilike('display_name', '%azam%');
console.log('Azam matches:', azamRows);
const azam = azamRows?.find((p) => p.role === 'tl') || azamRows?.[0];
if (!azam) { console.log('ABORT: no Azam profile found'); process.exit(1); }
console.log(`Reassigning Samran's resources to ${azam.display_name} (${azam.id})`);

// 2. Samran → reassign resources
const { data: reassigned, error: rErr } = await sb
  .from('resources')
  .update({ created_by: azam.id })
  .eq('created_by', SAMRAN_ID)
  .select('id');
if (rErr) { console.log('  reassign ERR:', rErr.message); process.exit(1); }
console.log(`  reassigned ${reassigned?.length || 0} resources`);

// 3. Test APC → delete his 1 resource
const { data: tAcrDel, error: tdErr } = await sb
  .from('resources')
  .delete()
  .eq('created_by', TESTAPC_ID)
  .select('id');
if (tdErr) console.log('  Test APC resource del ERR:', tdErr.message);
else console.log(`  Test APC resources deleted: ${tAcrDel?.length || 0}`);

// 4. Retry auth deletion for both.
for (const [name, id] of [['Samran', SAMRAN_ID], ['Test APC', TESTAPC_ID]]) {
  console.log(`\n--- delete ${name} ---`);
  const { error: dErr } = await sb.auth.admin.deleteUser(id);
  if (dErr) {
    console.log(`  auth.admin.deleteUser ERR: ${dErr.message}`);
    continue;
  }
  console.log('  auth user deleted ✓');
  const { data: profCheck } = await sb
    .from('profiles').select('id, display_name').eq('id', id).maybeSingle();
  console.log(profCheck
    ? `  ⚠ profile still present: ${profCheck.display_name}`
    : '  profile row gone ✓');
}
