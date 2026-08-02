// Re-runnable backup of the LOG tables the main Boss backup skips (audit_log +
// app_events). KEYSET pagination (WHERE id > last LIMIT 1000) — an index seek, so
// it never hits the deep-offset statement timeout. NDJSON, one row per line.
// Gitignored. Restore = batched re-insert of each line. Run: node scripts/backup-logs.mjs
import { sb } from '../migration/lib/supabase.js';
import fs from 'fs';
import path from 'path';

const OUTDIR = path.resolve('backups/logs');
fs.mkdirSync(OUTDIR, { recursive: true });
const stamp = new Date().toISOString().slice(0, 10);
const BATCH = 1000;

async function dump(table) {
  const { count } = await sb.from(table).select('*', { count: 'exact', head: true });
  const file = path.join(OUTDIR, `${table}_${stamp}.ndjson`);
  const ws = fs.createWriteStream(file);
  let lastId = null, written = 0;
  for (;;) {
    let q = sb.from(table).select('*').order('id', { ascending: true }).limit(BATCH);
    if (lastId !== null) q = q.gt('id', lastId);
    let data, error;
    for (let attempt = 0; attempt < 3; attempt++) {
      ({ data, error } = await q);
      if (!error) break;
    }
    if (error) throw new Error(`${table} after id=${lastId}: ${error.message}`);
    if (!data.length) break;
    let buf = ''; for (const row of data) buf += JSON.stringify(row) + '\n';
    if (!ws.write(buf)) await new Promise((r) => ws.once('drain', r));
    written += data.length;
    lastId = data[data.length - 1].id;
    process.stdout.write(`\r  ${table}: ${written}/${count} rows…`);
    if (data.length < BATCH) break;
  }
  await new Promise((r) => ws.end(r));
  const sizeMB = +(fs.statSync(file).size / 1048576).toFixed(2);
  console.log(`\r  ${table}: ${written}/${count} rows → ${path.relative(process.cwd(), file)} (${sizeMB} MB)   `);
  return { table, rows: written, expected: count, file: path.relative(process.cwd(), file), sizeMB };
}

const results = await Promise.all(['audit_log', 'app_events'].map(dump));
fs.writeFileSync(path.join(OUTDIR, `manifest_${stamp}.json`),
  JSON.stringify({ created_at: new Date().toISOString(), project: 'WurxOS-V2', tables: results }, null, 2));
console.log('\nBackup complete → backups/logs/manifest_' + stamp + '.json');
