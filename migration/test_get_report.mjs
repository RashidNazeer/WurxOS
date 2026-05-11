import { sb } from './lib/supabase.js';

const { data: rep } = await sb
  .from('reports')
  .select('id')
  .eq('type', 'weekly')
  .order('created_at', { ascending: false })
  .limit(1)
  .maybeSingle();

if (!rep) { console.log('no report'); process.exit(0); }

// Mimic what getReportV1 does: select * + joins, normalize
const { data: row } = await sb
  .from('reports')
  .select(`
    *,
    brand:brand_id(brand_name),
    author:author_id(display_name),
    submitter:submitted_by(display_name),
    verifier:verified_by(display_name),
    approver:approved_by(display_name),
    rejecter:rejected_by(display_name),
    reopener:reopened_by(display_name),
    last_editor:last_edited_by(display_name)
  `)
  .eq('id', rep.id)
  .maybeSingle();

console.log('row.data?.overallInsights (first 80 chars):',
  JSON.stringify(row.data?.overallInsights)?.slice(0, 80));
console.log('row.data?.topCreatorsInsights (first 80 chars):',
  JSON.stringify(row.data?.topCreatorsInsights)?.slice(0, 80));

// After ...data spread, these are at the root.
const spread = { ...row, ...row.data };
console.log('spread.overallInsights (first 80):',
  JSON.stringify(spread.overallInsights)?.slice(0, 80));
console.log('spread.topCreatorsInsights (first 80):',
  JSON.stringify(spread.topCreatorsInsights)?.slice(0, 80));
