import { sb } from './lib/supabase.js';
const { data } = await sb.from('tasks')
  .select('id, title, brand_id, assignee_id, created_by, status, category, assignee:assignee_id(display_name), creator:created_by(display_name)')
  .ilike('title', 'Chat Sort')
  .order('created_at', { ascending: false });
console.log(`Found ${data?.length} Chat Sort tasks:`);
data?.forEach(t => console.log(`  brand_id=${t.brand_id?.slice(0,8)||'NULL'}  assignee=${t.assignee?.display_name}  creator=${t.creator?.display_name}  status=${t.status}`));
process.exit(0);
