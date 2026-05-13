// Diff v1 knowledgeBase against v2 kb_articles.
//
// Reports: (a) docs only in v1, (b) docs in both that differ on
// title/category/visibility/url/version. Read-only.

import { fbDb } from './lib/firebase.js';
import { sb } from './lib/supabase.js';
import { fbDocIdToUuid } from './lib/uid.js';

const snap = await fbDb.collection('knowledgeBase').get();
console.log(`v1 KB total: ${snap.size}`);

const { data: v2Rows, error } = await sb
  .from('kb_articles')
  .select('id, legacy_id, title, category, visibility, url, version');
if (error) { console.error(error); process.exit(1); }
console.log(`v2 kb_articles total: ${v2Rows.length}\n`);

const v2ByLegacy = new Map();
const v2ById = new Map();
for (const r of v2Rows) {
  if (r.legacy_id) v2ByLegacy.set(r.legacy_id, r);
  v2ById.set(r.id, r);
}

const onlyInV1 = [];
const differs = [];

for (const d of snap.docs) {
  const v1 = d.data();
  const expectedV2Id = fbDocIdToUuid(d.id);
  // Match by legacy_id first, then by deterministic uuidv5 id.
  const v2 = v2ByLegacy.get(d.id) || v2ById.get(expectedV2Id);
  if (!v2) {
    onlyInV1.push({
      id: d.id,
      title: v1.title || '(untitled)',
      category: v1.tab || 'general',
      visibility: v1.visibility?.type || 'everyone',
      url: !!v1.url,
      createdBy: v1.createdBy || '(none)',
    });
    continue;
  }
  // Both exist — note diffs on the human-facing fields.
  const diff = {};
  if ((v1.title || '').trim() !== (v2.title || '').trim()) diff.title = [v1.title, v2.title];
  if ((v1.tab || 'general') !== v2.category)              diff.category = [v1.tab, v2.category];
  if ((v1.url || null) !== (v2.url || null))              diff.url = [v1.url, v2.url];
  if (Object.keys(diff).length) differs.push({ id: d.id, title: v1.title, diff });
}

console.log(`── Articles only in v1 (would be added on sync): ${onlyInV1.length} ──`);
for (const r of onlyInV1) {
  console.log(`  [${r.category}] ${r.title.slice(0, 70)}  url=${r.url}  by=${r.createdBy.slice(0, 8)}`);
}

console.log(`\n── Articles in both but differ: ${differs.length} ──`);
for (const r of differs.slice(0, 20)) {
  console.log(`  ${r.title?.slice(0, 60)}`);
  for (const [k, v] of Object.entries(r.diff)) {
    console.log(`    ${k}: v1=${JSON.stringify(v[0])?.slice(0, 60)}  v2=${JSON.stringify(v[1])?.slice(0, 60)}`);
  }
}
if (differs.length > 20) console.log(`  … and ${differs.length - 20} more`);

const v1Ids = new Set(snap.docs.map((d) => d.id));
const onlyInV2 = v2Rows.filter((r) => r.legacy_id && !v1Ids.has(r.legacy_id));
console.log(`\n── Articles only in v2 (no v1 source — would NOT be touched): ${onlyInV2.length} ──`);
for (const r of onlyInV2.slice(0, 10)) {
  console.log(`  [${r.category}] ${r.title?.slice(0, 70)}`);
}
if (onlyInV2.length > 10) console.log(`  … and ${onlyInV2.length - 10} more`);
