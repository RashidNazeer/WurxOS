// Read-only inspection of Azan Khan's tasks.
// Output: every open task assigned to him with brand_id, brand name,
// brand active flag, creator name, current brand assignment for the
// brand.

import { sb } from './lib/supabase.js';

// 1. Find Azan
const { data: azans } = await sb
  .from('profiles')
  .select('id, display_name, email, role, reports_to, is_active')
  .ilike('display_name', '%azan%khan%');

console.log('Azan match:');
console.log(azans);

if (!azans?.length) process.exit(0);
const azan = azans.find((a) => a.role === 'apc') || azans[0];
console.log(`\nUsing: ${azan.display_name} (${azan.email}) — role=${azan.role}, is_active=${azan.is_active}`);

// 2. His current brand assignments
const { data: myBrands } = await sb
  .from('brand_assignments')
  .select('brand_id, brands(id, brand_name, is_active, deleted_at, owner_id)')
  .eq('user_id', azan.id);

console.log(`\nAzan's current brand_assignments: ${myBrands?.length || 0}`);
for (const b of (myBrands || [])) {
  console.log(`  ${b.brands?.brand_name}  active=${b.brands?.is_active}  deleted=${!!b.brands?.deleted_at}  owner=${b.brands?.owner_id?.slice(0,8)}`);
}

// 3. All tasks where assignee is Azan, NOT done
const { data: tasks } = await sb
  .from('tasks')
  .select('id, title, status, brand_id, created_by, created_at, assignee_id, recurrence')
  .eq('assignee_id', azan.id)
  .neq('status', 'done')
  .order('created_at', { ascending: false });

console.log(`\nOpen tasks assigned to Azan: ${tasks?.length || 0}\n`);

// Resolve brand names and creator names for the tasks
const brandIds = [...new Set((tasks || []).map((t) => t.brand_id).filter(Boolean))];
const creatorIds = [...new Set((tasks || []).map((t) => t.created_by).filter(Boolean))];

const [{ data: brands }, { data: creators }] = await Promise.all([
  brandIds.length
    ? sb.from('brands').select('id, brand_name, is_active, deleted_at').in('id', brandIds)
    : Promise.resolve({ data: [] }),
  creatorIds.length
    ? sb.from('profiles').select('id, display_name, role').in('id', creatorIds)
    : Promise.resolve({ data: [] }),
]);
const brandsById = Object.fromEntries((brands || []).map((b) => [b.id, b]));
const creatorsById = Object.fromEntries((creators || []).map((c) => [c.id, c]));

// Build the brand → current APC map for the brands the tasks reference
const { data: currentAssign } = brandIds.length
  ? await sb.from('brand_assignments').select('brand_id, user_id').in('brand_id', brandIds)
  : { data: [] };
const currentApcByBrand = {};
for (const a of (currentAssign || [])) {
  (currentApcByBrand[a.brand_id] ||= []).push(a.user_id);
}

console.log('TITLE                                        BRAND                  B.ACTIVE  CREATOR               TASK-BRAND-CURRENT-APC-IS-AZAN?');
console.log('-'.repeat(140));
const grouped = { solidGold: 0, otherBrandStillAssignedToAzan: 0, otherBrandNotAssignedToAzan: 0, noBrand: 0 };
for (const t of (tasks || [])) {
  const b = t.brand_id ? brandsById[t.brand_id] : null;
  const c = t.created_by ? creatorsById[t.created_by] : null;
  const isAzanCurrentApc = b ? (currentApcByBrand[b.id] || []).includes(azan.id) : null;

  if (!b) grouped.noBrand++;
  else if (b.brand_name?.toLowerCase().includes('solid gold')) grouped.solidGold++;
  else if (isAzanCurrentApc) grouped.otherBrandStillAssignedToAzan++;
  else grouped.otherBrandNotAssignedToAzan++;

  console.log(
    `${(t.title || '').padEnd(44).slice(0,44)}  ${(b?.brand_name || '(no brand)').padEnd(22).slice(0,22)} ${(b?.is_active ? 'Y' : 'N').padEnd(9)} ${(c?.display_name || '(unknown)').padEnd(20).slice(0,20)}  ${isAzanCurrentApc === null ? '—' : (isAzanCurrentApc ? 'YES' : 'NO')}`
  );
}

console.log(`\n── Grouping ──`);
console.log(`  Solid Gold tasks:                                 ${grouped.solidGold}`);
console.log(`  Other-brand tasks where Azan is still APC of brand: ${grouped.otherBrandStillAssignedToAzan}`);
console.log(`  Other-brand tasks where Azan is NOT APC of brand:   ${grouped.otherBrandNotAssignedToAzan}`);
console.log(`  No-brand (general/personal) tasks:                  ${grouped.noBrand}`);
