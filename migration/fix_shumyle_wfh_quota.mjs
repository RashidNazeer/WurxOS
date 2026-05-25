// Fix Shumyle Asim's WFH quota: 0 -> 2 (standard IPC default).
import { sb } from './lib/supabase.js';

const { data: ipc, error: e1 } = await sb
  .from('profiles')
  .select('id, display_name, email, leave_quota')
  .eq('email', 'shumyle@wurxmedia.com')
  .maybeSingle();
if (e1) { console.log('ERR', e1.message); process.exit(1); }
if (!ipc) { console.log('Shumyle not found'); process.exit(1); }

console.log('Before:', JSON.stringify(ipc.leave_quota));
const next = { ...(ipc.leave_quota || {}), wfh: 2 };

const { data: upd, error: e2 } = await sb
  .from('profiles')
  .update({ leave_quota: next })
  .eq('id', ipc.id)
  .select('leave_quota')
  .single();
if (e2) { console.log('ERR', e2.message); process.exit(1); }

console.log('After: ', JSON.stringify(upd.leave_quota));
console.log('Done.');
