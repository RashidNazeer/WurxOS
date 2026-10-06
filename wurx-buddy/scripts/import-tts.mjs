// ============================================================
// TikTok Shop Academy crawl → public.tts_articles (Phase 3 first load).
// DEV ONLY (dev-env.mjs guard).
//
//   node --experimental-strip-types scripts/import-tts.mjs [--dry-run] [--jsonl <path>]
//   node --experimental-strip-types scripts/import-tts.mjs --apply --owner-approved
//
// Reads the reference crawler's articles.jsonl, picks one winner per repeated
// id by a fixed rule (ingest/ttsImport.ts), skips records without text, and
// compares content_hash with tts_articles: only new / changed / inactive
// articles are written, so a second import writes nothing (and, once the 374
// trigger exists, enqueues nothing).
//
// --dry-run (default) is read-only. --apply writes and needs --owner-approved:
// importing the crawl is under the INGESTION HOLD (TEAM.md rule 8).
// ============================================================
import fs from 'node:fs';
import pg from 'pg';
import { ASSISTANT, devDbUrl, SSL } from './dev-env.mjs';
import { importArticles } from '../supabase/functions/_shared/ai/ingest/ttsImport.ts';

const args = process.argv.slice(2);
const val = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const JSONL = val('--jsonl', `${ASSISTANT}/data/tts-academy/articles.jsonl`);
const APPLY = args.includes('--apply');

if (APPLY && !args.includes('--owner-approved')) {
  console.error([
    'Refusing to --apply: importing the TikTok crawl into tts_articles is under the',
    'INGESTION HOLD (Assistant/TEAM.md rule 8, Owner 2026-09-28).',
    'Re-run with --owner-approved only after the Owner has explicitly approved it.',
    'Without flags this script does a read-only dry run.',
  ].join('\n'));
  process.exit(2);
}
if (!fs.existsSync(JSONL)) { console.error(`not found: ${JSONL}`); process.exit(1); }

const records = fs.readFileSync(JSONL, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const c = new pg.Client({ connectionString: devDbUrl(), ssl: SSL, connectionTimeoutMillis: 20_000, query_timeout: 300_000 });
c.on('error', () => {});
await c.connect();
try {
  await c.query(APPLY ? 'begin' : 'begin read only');
  const r = await importArticles(c, records, { dryRun: !APPLY });
  await c.query(APPLY ? 'commit' : 'rollback');
  console.log(`${APPLY ? 'IMPORTED' : 'DRY RUN (read-only)'} from ${JSONL}`);
  console.log(`  records ${r.records} → unique ids ${r.uniqueIds} (${r.duplicateIds} ids repeated, one winner each)`);
  console.log(`  skipped, no text in any record: ${r.skippedEmpty.length}${r.skippedEmpty.length ? ` (${r.skippedEmpty.slice(0, 5).join(', ')}${r.skippedEmpty.length > 5 ? ', …' : ''})` : ''}`);
  console.log(`  ${APPLY ? '' : 'would be '}inserted ${r.inserted} · updated ${r.updated} · unchanged ${r.unchanged}${APPLY ? '' : ' (nothing written)'}`);
} catch (e) {
  await c.query('rollback').catch(() => {});
  throw e;
} finally {
  await c.end();
}
