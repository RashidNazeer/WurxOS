import { sb } from './lib/supabase.js';

const DEV = '87f3419d-5c90-537e-b41e-e4097330d670';
const APC = '3582f4f1-e018-507d-af98-8ae206320c5e';

async function retry(fn, label, maxTries = 3) {
  for (let i = 1; i <= maxTries; i++) {
    try { return await fn(); }
    catch (e) {
      console.warn(`  ${label}: try ${i} failed — ${e.message}`);
      if (i === maxTries) throw e;
      await new Promise(r => setTimeout(r, 800 * i));
    }
  }
}

// Insert Jun 1 + Jun 2 present rows (zero-hour, status=clocked-out) for the dev account
const datesToCreate = ['2026-06-01', '2026-06-02'];
for (const date of datesToCreate) {
  const { data: existing } = await sb
    .from('attendance').select('id').eq('user_id', DEV).eq('date', date).maybeSingle();
  if (existing) { console.log(`  ${date}: already exists, skip`); continue; }
  const t = `${date}T11:00:00+00:00`;
  await retry(async () => {
    const { error } = await sb.from('attendance').insert({
      user_id: DEV, date,
      clock_in: t, clock_out: t,
      status: 'clocked-out',
      breaks: [], total_work_ms: 0, total_break_ms: 0,
      auto_closed: false,
      legacy_id: `att:manualpresent_${DEV}_${date}`,
      location: 'bahria',
      created_at: new Date().toISOString(),
    });
    if (error) throw new Error(error.message);
  }, `attendance insert ${date}`);
  console.log(`  ${date}: ✓ inserted present`);
}

// Clean up the "active" leftovers on the deleted APC uid. Historical
// attendance/audit_log are kept (records of completed work). Only the
// active chat_members membership needs to go — same gate the Edge
// Function uses for normal deletions.
console.log('\nCleaning APC leftovers:');
const cleanupTables = ['chat_members'];
for (const t of cleanupTables) {
  try {
    const { error } = await sb.from(t).delete().eq('user_id', APC);
    console.log(`  ${t}: ${error ? '✗ ' + error.message : '✓ wiped'}`);
  } catch (e) { console.log(`  ${t}: threw ${e.message}`); }
}

// Verify state
const { data: post } = await sb
  .from('attendance').select('date, status, total_work_ms')
  .eq('user_id', DEV).gte('date', '2026-06-01').order('date');
console.log('\nDeveloper Rashid June attendance:');
for (const r of post || []) console.log(`  ${r.date}  ${r.status}  hours=${(r.total_work_ms || 0) / 3600000}`);

const { count: chatLeft } = await sb.from('chat_members').select('*', { count: 'exact', head: true }).eq('user_id', APC);
console.log(`\nAPC chat memberships remaining: ${chatLeft}`);
