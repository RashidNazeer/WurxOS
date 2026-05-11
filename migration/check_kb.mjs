import { sb } from './lib/supabase.js';

// Find boss
const { data: boss } = await sb
  .from('profiles')
  .select('id, display_name, email')
  .eq('role', 'boss')
  .eq('is_active', true)
  .limit(3);
console.log('Active boss(es):', boss);

// Existing categories
const { data: cats } = await sb
  .from('kb_articles')
  .select('category')
  .order('category');
const counts = {};
for (const r of (cats || [])) {
  counts[r.category] = (counts[r.category] || 0) + 1;
}
console.log('\nExisting categories (with counts):');
for (const [c, n] of Object.entries(counts).sort()) {
  console.log(`  ${c}: ${n}`);
}

// Check the columns available
const { data: sample } = await sb.from('kb_articles').select('*').limit(1);
if (sample?.length) {
  console.log('\nColumns:', Object.keys(sample[0]));
}
