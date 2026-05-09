// One-shot: reset every active profile whose leave_quota uses v1's
// shape ({wfh, casual, medical_emergency}) to v2's default
// {wfh:2, medical:1, emergency:1}.
//
// Why: the v1→v2 sync (step 02) copies v1's leaveQuota verbatim. v1
// uses keys {wfh, casual, medical_emergency} and a higher wfh number;
// v2's RPCs read {wfh, medical, emergency}. So the imported override
// makes wfh display "4 / month" (wrong — should be 2) and medical /
// emergency both show as 0 (broken — never read).
//
// Idempotent — re-running has no extra effect.

import { sb } from './lib/supabase.js';

const APPLY = process.argv.includes('--apply');
const V2_DEFAULT = { wfh: 2, medical: 1, emergency: 1 };

const { data: profiles, error } = await sb.from('profiles')
  .select('id, display_name, role, leave_quota')
  .eq('is_active', true)
  .is('deleted_at', null)
  .order('display_name');
if (error) { console.error(error); process.exit(1); }

// Targets: anyone whose leave_quota object uses v1's shape (has any of
// 'casual' or 'medical_emergency' keys). Leave already-correct rows alone.
const targets = (profiles || []).filter(p => {
  const q = p.leave_quota || {};
  return ('casual' in q) || ('medical_emergency' in q);
});

console.log(`Active profiles: ${profiles?.length || 0}`);
console.log(`Targets (using v1 shape): ${targets.length}\n`);
targets.forEach(p => {
  console.log(`  ${p.display_name?.padEnd(28) || '?'} ${p.role?.padEnd(4) || '?'}  current=${JSON.stringify(p.leave_quota)}`);
});
console.log(`\nNew value for each: ${JSON.stringify(V2_DEFAULT)}`);

if (!APPLY) {
  console.log('\nDRY-RUN — re-run with --apply to write.');
  process.exit(0);
}

let ok = 0, fail = 0;
for (const p of targets) {
  const { error: ue } = await sb.from('profiles')
    .update({ leave_quota: V2_DEFAULT })
    .eq('id', p.id);
  if (ue) { fail++; console.log(`  FAIL ${p.display_name}: ${ue.message}`); }
  else { ok++; }
}
console.log(`\nUpdated ${ok}/${targets.length}.${fail ? ` ${fail} failures.` : ''}`);
process.exit(0);
