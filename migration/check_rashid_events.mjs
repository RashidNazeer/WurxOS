import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const env = fs.readFileSync('.env.local', 'utf8');
const url = env.match(/VITE_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SERVICE_ROLL_KEY\s*=\s*(.+)/)[1].trim();
const sb = createClient(url, key, { auth: { persistSession: false } });

const uid = '3582f4f1-e018-507d-af98-8ae206320c5e';  // APC Rashid Nazeer

const { data: events } = await sb
  .from('app_events')
  .select('created_at, kind, route, detail')
  .eq('user_id', uid)
  .order('created_at', { ascending: false })
  .limit(60);

console.log(`${events.length} most recent events (UTC, newest first):\n`);
console.log('TIME (UTC)           KIND                         ROUTE                          DETAIL');
console.log('-'.repeat(140));
for (const e of events) {
  const t = new Date(e.created_at).toISOString().replace('T', ' ').slice(0, 19);
  const d = e.detail ? JSON.stringify(e.detail).slice(0, 70) : '';
  console.log(`${t}  ${(e.kind||'').padEnd(28)} ${(e.route || '').padEnd(30)} ${d}`);
}

console.log('\n--- Kind summary ---');
const byKind = {};
for (const e of events) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
console.log(byKind);
