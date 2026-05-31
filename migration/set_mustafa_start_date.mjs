import { sb } from './lib/supabase.js';

const uid = 'e3983541-0195-590c-a466-e61e2e430f1a';
const startDate = '2026-05-04';

const { data, error } = await sb
  .from('profiles')
  .update({ start_date: startDate, updated_at: new Date().toISOString() })
  .eq('id', uid)
  .select('id, display_name, start_date')
  .single();
if (error) { console.error(error); process.exit(1); }
console.log(`Updated: ${data.display_name}  start_date=${data.start_date}`);
