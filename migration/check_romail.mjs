import { sb } from './lib/supabase.js';

// Find Romail
const { data: prof } = await sb
  .from('profiles')
  .select('id, display_name, role, reports_to, is_active')
  .ilike('display_name', '%omail%')
  .limit(5);
console.log('Profiles matching "*omail*":');
console.log(prof);
if (!prof || !prof.length) process.exit(0);

for (const p of prof) {
  console.log(`\n=== ${p.display_name} (${p.id}) ===`);
  console.log(`  role=${p.role}, is_active=${p.is_active}`);
  console.log(`  reports_to=${p.reports_to}`);
  if (p.reports_to) {
    const { data: rt } = await sb.from('profiles').select('id, display_name, role').eq('id', p.reports_to).maybeSingle();
    console.log(`  reports_to → ${rt?.display_name} (${rt?.role})`);
  }
  // Their brand assignments
  const { data: ba } = await sb
    .from('brand_assignments')
    .select('brand:brand_id(id, brand_name, owner_id, status, owner:owner_id(display_name, role))')
    .eq('user_id', p.id);
  console.log(`  Brand assignments (${ba?.length || 0}):`);
  for (const a of (ba || [])) {
    const b = a.brand;
    if (!b) continue;
    console.log(`    - ${b.brand_name} [status=${b.status}] owner=${b.owner?.display_name} (${b.owner?.role}) [owner_id=${b.owner_id}]`);
  }
}
