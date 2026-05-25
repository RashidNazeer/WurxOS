// Quick check on Asad's tasks and Raees's owned brand.
import { sb } from './lib/supabase.js';

const ASAD_ID  = 'c866b2ea-2153-54b1-9917-aa881aa297eb';
const RAEES_ID = '1214d2f3-781d-58b1-bf52-3b3af21ccc3d';

const { data: tasks } = await sb
  .from('tasks').select('id, title, brand_id, status, created_by').eq('assignee_id', ASAD_ID);
console.log('Asad tasks:');
for (const t of tasks || []) {
  console.log(`  "${t.title}" (status=${t.status}, brand_id=${t.brand_id || '(none)'})`);
}

const { data: brands } = await sb
  .from('brands').select('id, brand_name, status').eq('owner_id', RAEES_ID);
console.log('\nRaees-owned brands:');
for (const b of brands || []) {
  console.log(`  "${b.brand_name}" (${b.id}, status=${b.status})`);
}
