import { sb } from './lib/supabase.js';

// Get one recent weekly report
const { data } = await sb
  .from('reports')
  .select('id, brand_id, type, period_start, data, brand:brand_id(brand_name)')
  .eq('type', 'weekly')
  .order('created_at', { ascending: false })
  .limit(1);
if (!data?.length) { console.log('no reports'); process.exit(0); }
const r = data[0];
console.log('Brand:', r.brand?.brand_name);
console.log('Period:', r.period_start);
console.log('Data keys:', Object.keys(r.data || {}));
console.log('overallInsights:', JSON.stringify(r.data?.overallInsights)?.slice(0, 100));
console.log('topCreatorsInsights:', JSON.stringify(r.data?.topCreatorsInsights)?.slice(0, 100));
console.log('topVideosInsights:', JSON.stringify(r.data?.topVideosInsights)?.slice(0, 100));
console.log('gmvMaxInsights:', JSON.stringify(r.data?.gmvMaxInsights)?.slice(0, 100));
console.log('productHighlightsInsights:', JSON.stringify(r.data?.productHighlightsInsights)?.slice(0, 100));
console.log('offsiteInsights:', JSON.stringify(r.data?.offsiteInsights)?.slice(0, 100));
