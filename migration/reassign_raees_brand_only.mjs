// Finish the Raees → Mustafa Jan reassignment by calling the
// purpose-built reassign_owned_brands RPC (mig 112), which sets
// wurxos.bypass_owner_guard before updating brands.owner_id and
// is service-role only.

import { sb } from './lib/supabase.js';

const RAEES_ID   = '1214d2f3-781d-58b1-bf52-3b3af21ccc3d';
const MUSTAFA_ID = 'e3983541-0195-590c-a466-e61e2e430f1a';

const { data, error } = await sb.rpc('reassign_owned_brands', {
  p_from_user: RAEES_ID,
  p_to_user:   MUSTAFA_ID,
});
if (error) { console.log('ERR', error.message); process.exit(1); }
console.log(`reassign_owned_brands(Raees -> Mustafa Jan) returned: ${data}`);

// Confirm
const { data: now } = await sb
  .from('brands').select('id, brand_name, owner_id').eq('owner_id', MUSTAFA_ID);
console.log(`Brands now owned by Mustafa Jan: ${now?.length}`);
for (const b of now || []) console.log(`  - ${b.brand_name}`);
