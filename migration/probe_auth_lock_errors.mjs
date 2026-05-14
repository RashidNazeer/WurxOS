// How widespread is the 'Lock broken' / AbortError noise?
// Counts in app_events from the last 7 days, grouped by user.

import { sb } from './lib/supabase.js';

const since = new Date(Date.now() - 7 * 86400_000).toISOString();

// All recent errors. Schema (mig 155): user_id, kind, detail jsonb, route, created_at.
const { data: rows, error } = await sb
  .from('app_events')
  .select('user_id, kind, detail, route, created_at, user:user_id(display_name, email)')
  .in('kind', ['error.reported'])
  .gte('created_at', since)
  .order('created_at', { ascending: false })
  .limit(1000);
if (error) { console.log('ERR', error.message); process.exit(1); }

console.log(`Error events since ${since}: ${rows?.length || 0}`);

const lockBroken = (rows || []).filter((r) =>
  String(r.detail?.message || '').includes('Lock broken'),
);
console.log(`\n"Lock broken" rejections: ${lockBroken.length}`);
const byUser = new Map();
lockBroken.forEach((r) => {
  const k = r.user?.email || r.user?.display_name || r.user_id || '(unknown)';
  byUser.set(k, (byUser.get(k) || 0) + 1);
});
console.log('Per-user count:');
[...byUser.entries()].sort((a, b) => b[1] - a[1]).forEach(([u, c]) => {
  console.log(`  ${u}: ${c}`);
});

console.log('\n=== Top 10 error patterns in last 7 days ===');
const byMsg = new Map();
(rows || []).forEach((r) => {
  const m = String(r.detail?.message || '').slice(0, 90);
  byMsg.set(m, (byMsg.get(m) || 0) + 1);
});
[...byMsg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([m, c]) => {
  console.log(`  ${c}x  ${m}`);
});
