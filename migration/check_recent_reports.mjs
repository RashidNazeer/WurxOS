import { sb } from './lib/supabase.js';

const { data } = await sb
  .from('reports')
  .select('id, type, period_start, brand:brand_id(brand_name), data')
  .eq('type', 'weekly')
  .order('created_at', { ascending: false })
  .limit(5);

for (const r of (data || [])) {
  const d = r.data || {};
  const has = (k) => d[k] && (typeof d[k] === 'string' ? d[k].length > 0 : Object.keys(d[k]).length > 0);
  console.log(`${r.brand?.brand_name?.padEnd(28)} ${r.period_start}`);
  console.log(`  overallInsights:           ${has('overallInsights')} (${(d.overallInsights || '').length} chars)`);
  console.log(`  topCreatorsInsights:       ${has('topCreatorsInsights')} (${(d.topCreatorsInsights || '').length} chars)`);
  console.log(`  topVideosInsights:         ${has('topVideosInsights')} (${(d.topVideosInsights || '').length} chars)`);
  console.log(`  gmvMaxInsights:            ${has('gmvMaxInsights')} (${(d.gmvMaxInsights || '').length} chars)`);
  console.log(`  productHighlightsInsights: ${has('productHighlightsInsights')} (${(d.productHighlightsInsights || '').length} chars)`);
  console.log(`  offsiteInsights:           ${has('offsiteInsights')} (${(d.offsiteInsights || '').length} chars)`);
}
