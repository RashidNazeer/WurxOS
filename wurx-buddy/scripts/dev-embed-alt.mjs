// DEV ONLY: turn on the NVIDIA alt index (embed_alt_always) and fill it for existing chunks by
// running the ingest worker in a loop until no chunk still needs an alt vector (or --max runs).
//   node --experimental-strip-types scripts/dev-embed-alt.mjs [--max 400]
import pg from 'pg';
import { execFileSync } from 'node:child_process';
import { devDbUrl, SSL } from './dev-env.mjs';

const max = Number(process.argv[process.argv.indexOf('--max') + 1]) || 400;
const db = new pg.Client({ connectionString: devDbUrl(), ssl: SSL });   // refuses anything but the dev project
await db.connect();
await db.query('update public.ai_assistant_config set embed_alt_always = true where id = 1');
const left = async () => (await db.query(`select count(*)::int n from public.ai_chunks c join public.ai_documents d on d.id = c.document_id
  where d.status = 'active' and c.embedding_alt is null and d.source_type = any(coalesce((select free_provider_sources from public.ai_assistant_config where id = 1), '{}'::text[]))`)).rows[0].n;
let before = await left();
console.log(`embed_alt_always on; chunks needing an NVIDIA vector: ${before}`);
for (let i = 1; i <= max && before > 0; i++) {
  execFileSync(process.execPath, ['--experimental-strip-types', 'scripts/ingest.mjs', '--drain', '--owner-approved'], { stdio: 'ignore' });
  const now = await left();
  if (i % 10 === 0 || now === 0) console.log(`run ${i}: ${now} left`);
  if (now >= before) { console.log(`run ${i}: no progress (${now} left); stopping. Check ai_ingest_stats / ai_vector_state.`); break; }
  before = now;
}
await db.end();
