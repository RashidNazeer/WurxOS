import { sb } from './lib/supabase.js';

const ids = [
  '5ac25471-36f1-4099-aa04-372b914ccdda',
  '47c04ae2-a78f-4b2b-a6ee-1fc60c20d46d',
  'df0d2fc3-3d89-4c87-80f3-2c26a2a4f80e',
  'edab3009-7235-4c50-a9c4-12d23e7a7822',
  '65d228d7-5973-471d-8502-66f022e06a60',
  'f60b3433-84e6-4e79-9ddb-114a1fee9348',
  '15902ad1-ec3f-4122-9201-60d45dce7f82',
  '0d27aa15-7e0e-4e98-8ea8-007846341ec4',
];

const { data, error } = await sb
  .from('kb_articles')
  .update({ body: '' })
  .in('id', ids)
  .select('id, title, url, body');
if (error) { console.error(error); process.exit(1); }
console.log(`Cleared body on ${data.length} articles:`);
for (const r of data) console.log(`  ${r.title} · body="${r.body}" url=${r.url ? '✓' : '✗'}`);
