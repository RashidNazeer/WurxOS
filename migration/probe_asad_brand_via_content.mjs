// Find Asad's old brand(s) by looking at his report.brand_id and
// resources.brand_id, then find the CURRENT APC of each brand —
// that's who his content should go to.

import { sb } from './lib/supabase.js';

const ASAD_ID = 'c866b2ea-2153-54b1-9917-aa881aa297eb';

const { data: reports } = await sb
  .from('reports').select('id, brand_id, period_start, period_end, status').eq('author_id', ASAD_ID);
console.log('Asad reports:', reports);

const { data: resources } = await sb
  .from('resources').select('id, brand_id, name, type').eq('created_by', ASAD_ID);
console.log(`\nAsad resources (${resources?.length}):`);
for (const r of resources || []) {
  console.log(`  ${r.name} (${r.type}, brand_id=${r.brand_id || '(none)'})`);
}

const brandIds = new Set();
(reports || []).forEach((r) => r.brand_id && brandIds.add(r.brand_id));
(resources || []).forEach((r) => r.brand_id && brandIds.add(r.brand_id));

console.log(`\nUnique brand IDs from Asad's content: ${[...brandIds].join(', ')}`);

for (const bid of brandIds) {
  const { data: brand } = await sb
    .from('brands').select('id, brand_name, owner_id, status').eq('id', bid).maybeSingle();
  const { data: links } = await sb
    .from('brand_assignments')
    .select('user_id, profile:user_id(display_name, email, role)')
    .eq('brand_id', bid);
  const { data: ownerProf } = await sb
    .from('profiles').select('display_name, role').eq('id', brand?.owner_id).maybeSingle();
  console.log(`\n  Brand "${brand?.brand_name}" (${brand?.id}, status=${brand?.status})`);
  console.log(`    owner (TL): ${ownerProf?.display_name} (${ownerProf?.role})`);
  console.log(`    current APC assignees:`, links?.map((l) => `${l.profile?.display_name} (${l.profile?.role})`).join(', ') || '(none)');
}
