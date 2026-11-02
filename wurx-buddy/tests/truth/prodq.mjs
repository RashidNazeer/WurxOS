// READ-ONLY query helper for the production project (Management API). Refuses anything but SELECT/WITH.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
function tok() {
  for (const f of ['.env.production']) {
    try { const m = readFileSync(resolve(root, f), 'utf8').match(/^SUPABASE_ACCESS_TOKEN=(.+)$/m); if (m) return m[1].trim().replace(/^["']|["']$/g, ''); } catch {}
  }
  throw new Error('no SUPABASE_ACCESS_TOKEN in .env.production');
}
export async function q(sql, ref = 'xoaaidgvblondjpvxjqp') {
  if (!/^\s*(select|with)\b/i.test(sql)) throw new Error('read-only helper: SELECT/WITH only');
  if (/\b(insert|update|delete|drop|alter|truncate|create|grant)\b/i.test(sql.replace(/'[^']*'/g, "''"))) throw new Error('read-only helper: mutating keyword');
  const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${tok()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: sql }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${t.slice(0, 400)}`);
  return JSON.parse(t);
}
if (process.argv[1] && process.argv[1].endsWith('prodq.mjs') && process.argv[2]) {
  console.log(JSON.stringify(await q(process.argv.slice(2).join(' ')), null, 1));
}
