// One-shot ongoing sync. Runs all idempotent steps in dependency order.
//
//   node sync-all.js              — dry-run everything
//   node sync-all.js --apply      — actually write to Supabase
//
// Skips:
//   - 00-audit (informational, run separately if you want a count)
//   - 01-auth-users (one-shot bootstrap that wipes v2 — DANGEROUS)
//   - 15-misc (config tables; safe to run, included)
//
// Uses 01b-auth-users-incremental for non-destructive Auth user catch-up.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apply = process.argv.includes('--apply');

const STEPS = [
  '01b',  // incremental auth user creation (safe — only adds new)
  '02',   // profiles (uses update, idempotent)
  '03',   // brands
  '04',   // attendance
  '05',   // kb
  '06',   // tasks
  '07',   // resources
  '08',   // leave-requests
  '09',   // performance
  '10',   // product-campaigns
  '11',   // incentives
  '12',   // campaigns
  '13',   // suggestions-reminders
  '14',   // reports-bugs
  '15',   // misc (anchors, app_config, etc.)
];

function runStep(stepId) {
  return new Promise((res, rej) => {
    const args = [resolve(__dirname, 'run.js'), stepId];
    if (apply) args.push('--apply');
    console.log(`\n========== STEP ${stepId} ${apply ? 'APPLY' : 'DRY-RUN'} ==========`);
    const p = spawn(process.execPath, args, { stdio: 'inherit' });
    p.on('exit', (code) => code === 0 ? res() : rej(new Error(`step ${stepId} exited ${code}`)));
  });
}

(async () => {
  for (const s of STEPS) {
    try { await runStep(s); }
    catch (e) {
      console.error(`!!! Sync halted at step ${s}: ${e.message}`);
      process.exit(1);
    }
  }
  console.log('\n=== sync-all complete ===');
})();
