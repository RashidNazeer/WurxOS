import { sb } from './lib/supabase.js';

// Inspect what error the brands query returns
const brandsRes = await sb.from('brands')
  .select('id, brand_name, is_active, deleted_at, owner_id')
  .limit(2000);
console.log('Raw brands response:', { error: brandsRes.error, count: brandsRes.data?.length, statusText: brandsRes.statusText, status: brandsRes.status });

// Try simplest possible
const minRes = await sb.from('brands').select('id', { count: 'exact' }).limit(1);
console.log('Minimal brands query:', { error: minRes.error, count: minRes.count, data: minRes.data });

// And: try a different table name we know — what columns exist?
const sampleRes = await sb.from('brands').select('*').limit(1);
console.log('Sample brands row:', { error: sampleRes.error, data: sampleRes.data });

const allBrands = brandsRes.data || [];
console.log(`Total brands: ${allBrands?.length || 0}`);
const matches = (allBrands || []).filter((b) => /solid|gold|pet/i.test(b.brand_name || ''));
console.log(`Solid/gold/pet brands (JS filter): ${matches.length}`);
for (const b of matches) {
  console.log(`  "${b.brand_name}"  active=${b.is_active}  deleted=${!!b.deleted_at}  id=${b.id}`);
}

// 2. Search all profiles for Azan
const { data: allProfiles } = await sb.from('profiles')
  .select('id, display_name, email, role, is_active, deleted_at')
  .limit(5000);
console.log(`\nTotal profiles: ${allProfiles?.length || 0}`);
const azans = (allProfiles || []).filter((p) => /azan/i.test(p.display_name || '') || /azan/i.test(p.email || ''));
console.log(`Azan profiles (JS filter): ${azans.length}`);
for (const a of azans) {
  console.log(`  "${a.display_name}"  email=${a.email}  role=${a.role}  active=${a.is_active}  id=${a.id}`);
}

// 3. Find Haider Ali (TL in screenshot)
const haiders = (allProfiles || []).filter((p) => /haider/i.test(p.display_name || ''));
console.log(`\nHaider profiles: ${haiders.length}`);
for (const a of haiders) {
  console.log(`  "${a.display_name}"  email=${a.email}  role=${a.role}  active=${a.is_active}  id=${a.id}`);
}
