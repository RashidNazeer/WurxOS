// Restore a log table from an NDJSON backup made by backup-logs.mjs.
// Idempotent: INSERT ... ON CONFLICT (id) DO NOTHING — re-inserts only the rows
// that are missing, never clobbers or duplicates existing ones.
// Usage: node scripts/restore-logs.mjs backups/logs/audit_log_2026-08-02.ndjson audit_log
import { sb } from '../migration/lib/supabase.js';
import fs from 'fs';

const [file, table] = process.argv.slice(2);
if (!file || !table) { console.error('Usage: node scripts/restore-logs.mjs <file.ndjson> <table>'); process.exit(1); }
const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
console.log(`Restoring ${rows.length} rows into ${table} (insert-missing, idempotent)…`);
const BATCH = 500; let done = 0;
for (let i = 0; i < rows.length; i += BATCH) {
  const chunk = rows.slice(i, i + BATCH);
  const { error } = await sb.from(table).upsert(chunk, { onConflict: 'id', ignoreDuplicates: true });
  if (error) { console.error(`\nbatch at ${i}: ${error.message}`); process.exit(1); }
  done += chunk.length;
  process.stdout.write(`\r  ${done}/${rows.length}…`);
}
console.log(`\nRestored ${done} rows into ${table}.`);
