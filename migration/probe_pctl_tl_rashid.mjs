// Probe Test PCTL + TL Rashid Nazeer for deletion. Confirm we don't
// touch the APC Rashid (rashidnazeer@wurxmedia.com).

import { sb } from './lib/supabase.js';

const TL_RASHID_ID = '6ab21939-03da-512b-946c-ae67ddb6e60b'; // rashidtl@wurxmedia.com
const APC_RASHID_ID = '3582f4f1-e018-507d-af98-8ae206320c5e'; // rashidnazeer@wurxmedia.com (PRESERVE)

console.log('=== Test PCTL ===');
const { data: pctls } = await sb
  .from('profiles')
  .select('id, display_name, email, role, reports_to, is_active, deleted_at')
  .ilike('display_name', '%test%pctl%');
for (const u of pctls || []) {
  console.log(`  ${u.display_name} | ${u.email} | role=${u.role} | active=${u.is_active} | id=${u.id}`);
  const [brands, links, tasks, reports, resources, attendance, reportees] = await Promise.all([
    sb.from('brands').select('id, brand_name', { count: 'exact', head: false }).eq('owner_id', u.id),
    sb.from('brand_assignments').select('brand_id', { count: 'exact', head: true }).eq('user_id', u.id),
    sb.from('tasks').select('id', { count: 'exact', head: true }).eq('assignee_id', u.id),
    sb.from('reports').select('id', { count: 'exact', head: true }).eq('author_id', u.id),
    sb.from('resources').select('id', { count: 'exact', head: true }).eq('created_by', u.id),
    sb.from('attendance').select('id', { count: 'exact', head: true }).eq('user_id', u.id),
    sb.from('profiles').select('id, display_name', { count: 'exact' }).eq('reports_to', u.id),
  ]);
  console.log(`    └─ owns_brands=${brands.data?.length || 0}, assigned_brands=${links.count}, tasks=${tasks.count}, reports=${reports.count}, resources=${resources.count}, attendance=${attendance.count}, reportees=${reportees.count}`);
  if ((brands.data || []).length) console.log(`       brands: ${brands.data.map((b) => b.brand_name).join(', ')}`);
}

console.log('\n=== TL Rashid (rashidtl@wurxmedia.com) ===');
const { data: tlRashid } = await sb
  .from('profiles').select('id, display_name, email, role, is_active').eq('id', TL_RASHID_ID).maybeSingle();
console.log(tlRashid);
if (tlRashid) {
  const [brands, links, tasks, reports, resources, attendance, reportees] = await Promise.all([
    sb.from('brands').select('id, brand_name', { count: 'exact', head: false }).eq('owner_id', tlRashid.id),
    sb.from('brand_assignments').select('brand_id', { count: 'exact', head: true }).eq('user_id', tlRashid.id),
    sb.from('tasks').select('id', { count: 'exact', head: true }).eq('assignee_id', tlRashid.id),
    sb.from('reports').select('id', { count: 'exact', head: true }).eq('author_id', tlRashid.id),
    sb.from('resources').select('id', { count: 'exact', head: true }).eq('created_by', tlRashid.id),
    sb.from('attendance').select('id', { count: 'exact', head: true }).eq('user_id', tlRashid.id),
    sb.from('profiles').select('id, display_name, role', { count: 'exact' }).eq('reports_to', tlRashid.id),
  ]);
  console.log(`    └─ owns_brands=${brands.data?.length || 0}, assigned_brands=${links.count}, tasks=${tasks.count}, reports=${reports.count}, resources=${resources.count}, attendance=${attendance.count}, reportees=${reportees.count}`);
  if ((brands.data || []).length) console.log(`       brands: ${brands.data.map((b) => b.brand_name).join(', ')}`);
  if ((reportees.data || []).length) console.log(`       reportees:`, reportees.data.map((r) => `${r.display_name} (${r.role})`).join(', '));
}

console.log('\n=== Confirm APC Rashid is UNTOUCHED ===');
const { data: apcR } = await sb
  .from('profiles').select('id, display_name, email, role, is_active').eq('id', APC_RASHID_ID).maybeSingle();
console.log(apcR);
