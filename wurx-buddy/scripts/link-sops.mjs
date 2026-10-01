// ============================================================
// Link imported SOP docs to their KB article (decision 3). DEV ONLY.
//
//   node scripts/link-sops.mjs            dry run: print the match table
//   node scripts/link-sops.mjs --apply    also write kb_article_id for HIGH matches
//
// Writes the full report to data/sop-kb-links.json (gitignored).
// Never overwrites an existing link; a different existing link is reported
// as a conflict. Unlinked imported docs are never indexed (aiDoc.ts), so a
// miss here costs recall, never a leak.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { ASSISTANT, devDbUrl, SSL } from './dev-env.mjs';
import { matchSops } from './sop-match.mjs';

const APPLY = process.argv.includes('--apply');
const client = new pg.Client({ connectionString: devDbUrl(), ssl: SSL, connectionTimeoutMillis: 20_000 });
await client.connect();

try {
  const { rows: docs } = await client.query(
    `select id, title, content, is_active, kb_article_id from public.ai_assistant_docs order by title`);
  const { rows: kbs } = await client.query(
    `select id, title, url, visibility, approval_status, sop_group_id, version from public.kb_articles`);
  const results = matchSops(docs, kbs);

  const short = (s, n) => (String(s ?? '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s ?? ''));
  const table = results.map((r) => ({
    doc: short(r.doc.title, 58), kb: r.confidence === 'none' ? '' : short(r.kb?.title, 44),
    method: r.method, conf: r.confidence, score: r.score, vis: r.confidence === 'none' ? '' : r.kb?.visibility,
  }));
  const order = { high: 0, medium: 1, none: 2 };
  table.sort((a, b) => order[a.conf] - order[b.conf] || a.doc.localeCompare(b.doc));
  console.table(table);

  const count = (c) => results.filter((r) => r.confidence === c).length;
  const high = results.filter((r) => r.confidence === 'high');
  const restricted = kbs.filter((k) => k.visibility !== 'office' && k.approval_status === 'approved');
  const linkedRestricted = restricted.filter((k) => high.some((r) => r.kb.id === k.id));
  const kbLinked = new Set(high.map((r) => r.kb.id));

  let written = 0, kept = 0;
  const conflicts = [];
  if (APPLY) {
    await client.query('begin');
    for (const r of high) {
      if (r.doc.kb_article_id === r.kb.id) { kept++; continue; }
      if (r.doc.kb_article_id) { conflicts.push({ doc: r.doc.id, existing: r.doc.kb_article_id, proposed: r.kb.id }); continue; }
      const res = await client.query(
        'update public.ai_assistant_docs set kb_article_id = $1 where id = $2 and kb_article_id is null', [r.kb.id, r.doc.id]);
      written += res.rowCount;
    }
    await client.query('commit');
  }

  const summary = {
    generated_at: new Date().toISOString(), applied: APPLY,
    imported_docs: results.length, high: count('high'), medium: count('medium'), unmatched: count('none'),
    kb_articles_linked: kbLinked.size,
    restricted_kb_articles: restricted.length, restricted_kb_articles_linked: linkedRestricted.length,
    restricted_unlinked: restricted.filter((k) => !kbLinked.has(k.id)).map((k) => k.title),
    written, already_linked: kept, conflicts,
  };
  const report = {
    summary,
    matches: results.map((r) => ({
      doc_id: r.doc.id, doc_title: r.doc.title, doc_active: r.doc.is_active,
      kb_article_id: r.kb?.id ?? null, kb_title: r.kb?.title ?? null, kb_visibility: r.kb?.visibility ?? null,
      method: r.method, confidence: r.confidence, score: r.score, candidates: r.candidates ?? null,
    })),
  };
  const out = path.join(ASSISTANT, 'data', 'sop-kb-links.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));

  console.log(`\nimported SOP docs: ${summary.imported_docs}  high: ${summary.high}  medium: ${summary.medium}  unmatched: ${summary.unmatched}`);
  console.log(`KB articles with a linked SOP: ${summary.kb_articles_linked}; role-restricted approved KB articles linked: ${summary.restricted_kb_articles_linked} of ${summary.restricted_kb_articles}`);
  if (summary.restricted_unlinked.length) console.log(`restricted KB articles with no SOP doc: ${summary.restricted_unlinked.join(' | ')}`);
  console.log(APPLY ? `applied: ${written} written, ${kept} already linked, ${conflicts.length} conflicts (not changed)` : 'dry run: nothing written (use --apply)');
  console.log(`report: ${path.relative(ASSISTANT, out)}`);
} finally {
  await client.end();
}
