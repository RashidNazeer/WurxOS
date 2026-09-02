// Smoke-test the demo deployment: sign in as one person from every role and
// count what they can actually see.
//
//   node scripts/demo-smoke.mjs
//
// This runs through the ANON key and a real session, so every number below is
// produced by RLS — the same gate the browser goes through. It is the fastest
// way to confirm a re-seed left the demo in a state worth showing, and it also
// proves the permission boundaries are real rather than cosmetic, which is the
// thing a technical visitor is most likely to poke at.
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readEnv = (f) => {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) return {};
  return Object.fromEntries(fs.readFileSync(p, 'utf8').split('\n')
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
};
const e = { ...readEnv('.env.demo'), ...readEnv('.env.demo.local') };
const PW = e.VITE_DEMO_PASSWORD;

const CASES = [
  ['adrian.vance@meridian.example.com',    'boss'],
  ['priya.raghavan@meridian.example.com',  'ol'],
  ['marcus.bell@meridian.example.com',     'tl'],
  ['leo.fontaine@meridian.example.com',    'apc'],
  ['dana.whitfield@meridian.example.com',  'ads_manager'],
  ['ruth.adeyemi@meridian.example.com',    'ipc'],
];

const TABLES = ['brands', 'reports', 'tasks', 'incentives', 'profiles', 'attendance'];
console.log(['role'.padEnd(12), ...TABLES.map((t) => t.padStart(11))].join(''));
console.log('-'.repeat(12 + TABLES.length * 11));

for (const [email, role] of CASES) {
  const sb = createClient(e.VITE_SUPABASE_URL, e.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { error } = await sb.auth.signInWithPassword({ email, password: PW });
  if (error) { console.log(`${role.padEnd(12)} SIGN-IN FAILED: ${error.message}`); continue; }
  const counts = [];
  for (const t of TABLES) {
    const { count, error: err } = await sb.from(t).select('*', { count: 'exact', head: true });
    counts.push(String(err ? 'ERR' : count).padStart(11));
  }
  console.log(role.padEnd(12) + counts.join(''));
  await sb.auth.signOut();
}
