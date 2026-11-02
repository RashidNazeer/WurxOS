// Shared by the embedding benchmark scripts. Reads ../../../.env.dev (dev keys) and, for the corpus export only,
// ../../../.env.production's SUPABASE_ACCESS_TOKEN (READ-ONLY queries through the Management API).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export function env(file) {
  const o = {};
  for (const l of fs.readFileSync(path.join(ROOT, file), 'utf8').split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(l); if (m) o[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return o;
}
export async function prodQuery(query) {
  const t = env('.env.production').SUPABASE_ACCESS_TOKEN;
  const r = await fetch('https://api.supabase.com/v1/projects/xoaaidgvblondjpvxjqp/database/query', {
    method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify({ query }) });
  const txt = await r.text();
  if (!r.ok) throw new Error(`prod ${r.status}: ${txt.slice(0, 300)}`);
  return JSON.parse(txt);
}
