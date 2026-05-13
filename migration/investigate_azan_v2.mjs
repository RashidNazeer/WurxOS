import { sb } from './lib/supabase.js';

const AZAN = '0beaff2d-dc51-5cdb-a97e-a1f4a67b3f46';
const ALI_HAMZA = '7ab9eeb2'; // prefix
const HAIDER = 'c0fd1182-dff8-5027-b218-7ddfa54bf365';

// 1. Solid Gold Pets brand
const { data: brands } = await sb.from('brands')
  .select('*')
  .ilike('brand_name', '%solid gold%');
console.log(`"Solid Gold" brands: ${brands?.length}`);
console.log(brands);

// 2. Azan's brand_assignments
const { data: ba } = await sb.from('brand_assignments')
  .select('brand_id, user_id, assigned_at, brands(brand_name, status, owner_id)')
  .eq('user_id', AZAN);
console.log(`\nAzan's brand_assignments: ${ba?.length}`);
for (const a of ba || []) console.log(`  brand=${a.brands?.brand_name}  status=${a.brands?.status}  owner=${a.brands?.owner_id?.slice(0,8)}  assigned_at=${a.assigned_at}`);

// Sample tasks row to see schema
const sampleRes = await sb.from('tasks').select('*').limit(1);
console.log('\nTasks schema (sample row):', Object.keys(sampleRes.data?.[0] || {}));

// 3. Azan's open tasks
const taskRes = await sb.from('tasks')
  .select('*')
  .eq('assignee_id', AZAN)
  .neq('status', 'done')
  .order('created_at', { ascending: false });
if (taskRes.error) console.log('tasks query error:', taskRes.error);
const tasks = taskRes.data;
console.log(`\nAzan open tasks: ${tasks?.length}`);

// Enrich with brand + creator
const brandIds = [...new Set((tasks || []).map((t) => t.brand_id).filter(Boolean))];
const creatorIds = [...new Set((tasks || []).map((t) => t.created_by).filter(Boolean))];
const [{ data: brs }, { data: crs }] = await Promise.all([
  brandIds.length ? sb.from('brands').select('id, brand_name, status').in('id', brandIds) : { data: [] },
  creatorIds.length ? sb.from('profiles').select('id, display_name, role').in('id', creatorIds) : { data: [] },
]);
const bById = Object.fromEntries((brs || []).map((b) => [b.id, b]));
const cById = Object.fromEntries((crs || []).map((c) => [c.id, c]));

// Azan's current brand IDs for grouping
const myBrandIds = new Set((ba || []).map((a) => a.brand_id));

const groups = { solidGold: [], otherCurrentBrand: [], formerBrand: [], noBrand: [] };
const solidGoldId = brands?.[0]?.id;

console.log('\nTITLE                                  STATUS    BRAND                  B.STATUS   CREATOR                 ASSIGNED-TO-AZAN-VIA-BRAND?');
console.log('-'.repeat(150));
for (const t of (tasks || [])) {
  const b = t.brand_id ? bById[t.brand_id] : null;
  const c = t.created_by ? cById[t.created_by] : null;
  const isCurrentBrand = t.brand_id && myBrandIds.has(t.brand_id);

  if (!t.brand_id) groups.noBrand.push(t);
  else if (t.brand_id === solidGoldId) groups.solidGold.push(t);
  else if (isCurrentBrand) groups.otherCurrentBrand.push(t);
  else groups.formerBrand.push(t);

  console.log(
    `${(t.title || '').padEnd(38).slice(0,38)} ${(t.status||'').padEnd(9)} ${(b?.brand_name||'(none)').padEnd(22).slice(0,22)} ${(b?.status||'—').padEnd(10)} ${(c?.display_name||'(?)').padEnd(22).slice(0,22)}  ${isCurrentBrand ? 'YES' : (t.brand_id ? 'NO' : '—')}`
  );
}

console.log(`\nGrouping:`);
console.log(`  Solid Gold tasks:                       ${groups.solidGold.length}`);
console.log(`  Other-current-brand tasks (keep):       ${groups.otherCurrentBrand.length}`);
console.log(`  FORMER-brand tasks (delete candidates): ${groups.formerBrand.length}`);
console.log(`  No-brand (general/personal) tasks:      ${groups.noBrand.length}`);

// Detailed look at former-brand tasks: who created them, which brand
if (groups.formerBrand.length) {
  console.log('\nFormer-brand tasks (proposed delete) — full detail:');
  for (const t of groups.formerBrand) {
    const b = bById[t.brand_id];
    const c = cById[t.created_by];
    console.log(`  ${t.id.slice(0,8)} "${t.title?.slice(0,40)}"  brand="${b?.brand_name}"(${b?.status})  creator="${c?.display_name}"(${c?.role})  recurrence=${t.recurrence}`);
  }
}

// No-brand tasks: who created them?
if (groups.noBrand.length) {
  console.log('\nNo-brand tasks — full detail:');
  for (const t of groups.noBrand) {
    const c = cById[t.created_by];
    console.log(`  ${t.id.slice(0,8)} "${t.title?.slice(0,40)}"  creator="${c?.display_name}"(${c?.role})  recurrence=${t.recurrence}  created=${t.created_at?.slice(0,10)}`);
  }
}
