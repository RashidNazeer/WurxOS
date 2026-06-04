import { sb } from './lib/supabase.js';

const CAMP_ID = 'c0d3c661-1e37-55f0-ab32-f82f95f953c6';

const { data: c } = await sb
  .from('campaigns')
  .select('*, brand:brand_id(brand_name, owner_id, owner:owner_id(display_name, role)), addedBy:added_by(display_name, role)')
  .eq('id', CAMP_ID)
  .maybeSingle();

if (!c) { console.error('Campaign not found'); process.exit(1); }
console.log(`Campaign: ${c.title || c.id}`);
console.log(`  brand: ${c.brand?.brand_name}  brand_owner: ${c.brand?.owner?.display_name} (${c.brand?.owner?.role})`);
console.log(`  added_by: ${c.addedBy?.display_name} (${c.addedBy?.role})  uid=${c.added_by}`);
console.log(`  owner_id (campaign): ${c.owner_id}`);
console.log(`  status: ${c.status}`);
console.log(`  created_at: ${c.created_at}`);
console.log(`  brand_id: ${c.brand_id}`);

console.log('\nWho CAN currently update this campaign:');
console.log(`  - ${c.added_by} (the user who added it)`);
console.log(`  - Boss`);
console.log(`  - any active OL or Developer`);
console.log(`  - the brand's owner_id ${c.brand?.owner_id}`);

// Look at brand_assignments for this brand to see who else works on it
const { data: assigns } = await sb
  .from('brand_assignments')
  .select('user_id, profile:user_id(display_name, role, is_active, deleted_at)')
  .eq('brand_id', c.brand_id);
console.log(`\nBrand has ${(assigns || []).length} assignment(s):`);
for (const a of assigns || []) {
  if (a.profile?.deleted_at) continue;
  console.log(`  ${a.user_id}  ${a.profile?.display_name} (${a.profile?.role}) active=${a.profile?.is_active}`);
  console.log(`    → can SELECT yes (per cmp_select), but can UPDATE? ${a.profile?.role === 'tl' && a.user_id === c.brand?.owner_id ? 'yes (TL owner)' : 'NO'}`);
}
