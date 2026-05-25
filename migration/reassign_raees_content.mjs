// Reassign Raees Ali Azeem's content to Mustafa Jan.
// Auth user untouched in this pass — separate authorization.

import { sb } from './lib/supabase.js';

const RAEES_ID   = '1214d2f3-781d-58b1-bf52-3b3af21ccc3d';
const MUSTAFA_ID = 'e3983541-0195-590c-a466-e61e2e430f1a';

console.log(`Reassigning Raees Ali Azeem (${RAEES_ID}) content to Mustafa Jan (${MUSTAFA_ID})`);

const { data: rRep, error: eRep } = await sb
  .from('reports').update({ author_id: MUSTAFA_ID })
  .eq('author_id', RAEES_ID).select('id');
if (eRep) console.log(`  reports ERR: ${eRep.message}`);
else      console.log(`  reports.author_id reassigned: ${rRep?.length || 0}`);

const { data: rBr, error: eBr } = await sb
  .from('brands').update({ owner_id: MUSTAFA_ID })
  .eq('owner_id', RAEES_ID).select('id, brand_name');
if (eBr) console.log(`  brands ERR: ${eBr.message}`);
else     console.log(`  brands.owner_id reassigned: ${rBr?.length || 0} (${(rBr || []).map((b) => b.brand_name).join(', ')})`);

// Resources — none expected per the probe, but sweep anyway for safety.
const { data: rRes, error: eRes } = await sb
  .from('resources').update({ created_by: MUSTAFA_ID })
  .eq('created_by', RAEES_ID).select('id');
if (eRes) console.log(`  resources ERR: ${eRes.message}`);
else      console.log(`  resources.created_by reassigned: ${rRes?.length || 0}`);

console.log('\nDone. Auth user not deleted.');
