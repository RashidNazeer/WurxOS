// Migration runner. Usage:
//   node run.js audit             — read-only audit of v1 + v2
//   node run.js <NN>              — dry-run of step NN (default)
//   node run.js <NN> --apply      — actually write to v2
//
// Steps live in ./steps/ and are named NN-name.js. Each step exports
// nothing here — we just import it and let it run.

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const stepsDir = resolve(__dirname, 'steps');

const arg = process.argv[2];
const apply = process.argv.includes('--apply');

if (!arg) {
  console.error('Usage: node run.js <step-id|audit> [--apply]');
  console.error('Available steps:');
  for (const f of readdirSync(stepsDir).sort()) {
    console.error('  ' + f.replace(/\.js$/, ''));
  }
  process.exit(1);
}

// Make APPLY visible to steps via env so they don't need to re-parse argv.
process.env.MIGRATION_APPLY = apply ? '1' : '';

const target = arg === 'audit' ? '00-audit'
  : readdirSync(stepsDir).find((f) => f.startsWith(arg + '-'))?.replace(/\.js$/, '');

if (!target) {
  console.error(`No step matched "${arg}".`);
  process.exit(1);
}

if (apply) {
  console.log(`>>> APPLY MODE — will write to Supabase. Step: ${target}`);
} else {
  console.log(`>>> DRY-RUN MODE — no writes. Step: ${target}`);
}

await import(`./steps/${target}.js`);
