// Grant Abdul Subhan (TL) the canViewAllBrands permission so he sees
// every active brand the same way Boss/OL would. Special-case per
// 2026-06-04 instruction.
import { sb } from './lib/supabase.js';

const { data: subhan } = await sb
  .from('profiles')
  .select('id, display_name, role, permissions')
  .ilike('display_name', '%abdul%subhan%')
  .single();

if (!subhan) { console.error('Abdul Subhan not found'); process.exit(1); }
console.log(`Found: ${subhan.display_name} (${subhan.role})`);
console.log(`Current permissions: ${JSON.stringify(subhan.permissions || {})}`);

const next = { ...(subhan.permissions || {}), canViewAllBrands: true };
const { error } = await sb
  .from('profiles')
  .update({ permissions: next, updated_at: new Date().toISOString() })
  .eq('id', subhan.id);
if (error) { console.error(error); process.exit(1); }
console.log(`Updated permissions: ${JSON.stringify(next)}`);

// Verify the RLS function gives Subhan visibility into a sample brand
// he doesn't own (sanity check: pick any active brand).
const { data: sample } = await sb
  .from('brands')
  .select('id, brand_name, owner_id')
  .eq('status', 'active')
  .neq('owner_id', subhan.id)
  .limit(1)
  .single();
if (sample) {
  const { data: canSee } = await sb.rpc('can_view_brand', {
    b_owner: sample.owner_id, b_id: sample.id, uid: subhan.id,
  });
  console.log(`\nCan Subhan now see "${sample.brand_name}" (owned by someone else)?  ${canSee ? '✓ YES' : '✗ NO'}`);
}
