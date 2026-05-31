import { sb } from './lib/supabase.js';

// Sample a profile row to see all available fields
const { data: prof } = await sb
  .from('profiles')
  .select('*')
  .eq('id', 'e3983541-0195-590c-a466-e61e2e430f1a')
  .single();
console.log('Profile columns:');
for (const k of Object.keys(prof || {})) console.log(`  ${k}: ${JSON.stringify(prof[k])}`);

// Sample one of his attendance rows
const { data: att } = await sb
  .from('attendance')
  .select('*')
  .eq('user_id', 'e3983541-0195-590c-a466-e61e2e430f1a')
  .eq('date', '2026-05-04')
  .single();
console.log('\nAttendance row columns (May 4):');
for (const k of Object.keys(att || {})) console.log(`  ${k}: ${JSON.stringify(att[k])}`);
