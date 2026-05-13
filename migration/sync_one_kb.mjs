// One-shot: insert just "Example Projection - Penetrex" from v1 KB
// into v2 kb_articles. Mirrors steps/05-kb.js's field mapping but
// scoped to exactly one v1 doc, identified by title.

import { fbDb } from './lib/firebase.js';
import { sb } from './lib/supabase.js';
import { fbUidToUuid, fbDocIdToUuid } from './lib/uid.js';

const TARGET_TITLE = 'Example Projection - Penetrex';

const VALID_ROLES = new Set(['boss','ol','tl','pctl','apc','ipc','developer']);

function ts(v) {
  if (!v) return null;
  if (v._seconds) return new Date(v._seconds * 1000).toISOString();
  if (v.toDate) return v.toDate().toISOString();
  return null;
}

function mapVisibility(visObj) {
  if (!visObj || typeof visObj !== 'object') {
    return { visibility: 'office', visible_to_roles: [] };
  }
  if (visObj.type === 'roles' && Array.isArray(visObj.roles) && visObj.roles.length > 0) {
    const roles = visObj.roles
      .map((r) => r === 'dev' ? 'developer' : r)
      .filter((r) => VALID_ROLES.has(r));
    if (roles.length > 0) return { visibility: 'role', visible_to_roles: roles };
  }
  return { visibility: 'office', visible_to_roles: [] };
}

function parseVersion(s) {
  if (!s) return { num: 1, label: null };
  const str = String(s).trim();
  const m = str.match(/^(\d+)/);
  const num = m ? parseInt(m[1], 10) : 1;
  const label = /^\d+(\.0+)?$/.test(str) ? null : str;
  return { num: num || 1, label };
}

// Find the v1 doc by exact title.
const snap = await fbDb.collection('knowledgeBase').where('title', '==', TARGET_TITLE).get();
if (snap.empty) {
  console.error(`No v1 KB doc found with title "${TARGET_TITLE}"`);
  process.exit(1);
}
if (snap.size > 1) {
  console.warn(`Multiple v1 docs match — using the first.`);
}
const d = snap.docs[0];
const k = d.data();
console.log(`v1 doc: id=${d.id}  category=${k.tab}  visibility=${k.visibility?.type}  url=${k.url ? 'yes' : 'no'}`);

// Resolve created_by — must exist in v2 profiles or insert will fail.
const createdBy = k.createdBy ? fbUidToUuid(k.createdBy) : null;
const v2Id = fbDocIdToUuid(d.id);

const { data: profMatch } = await sb
  .from('profiles')
  .select('id, display_name')
  .eq('id', createdBy)
  .maybeSingle();

if (!profMatch) {
  console.error(`created_by ${k.createdBy} (uuid ${createdBy}) is not in v2 profiles. Cannot insert without a valid creator.`);
  process.exit(1);
}
console.log(`Creator in v2: ${profMatch.display_name}`);

// Confirm we're not about to clobber.
const { data: existing } = await sb
  .from('kb_articles')
  .select('id, title')
  .or(`id.eq.${v2Id},legacy_id.eq.${d.id}`);
if (existing?.length) {
  console.error(`A v2 row already exists for this article: ${JSON.stringify(existing)}`);
  process.exit(1);
}

const vis = mapVisibility(k.visibility);
const { num: vNum, label: vLabel } = parseVersion(k.version);
let approvedBy = k.approvedBy ? fbUidToUuid(k.approvedBy) : null;
if (approvedBy) {
  const { data: ap } = await sb.from('profiles').select('id').eq('id', approvedBy).maybeSingle();
  if (!ap) approvedBy = null;
}

const row = {
  id: v2Id,
  legacy_id: d.id,
  title: (k.title || '(untitled)').slice(0, 500),
  body: '',
  category: k.tab || 'general',
  visibility: vis.visibility,
  visible_to_roles: vis.visible_to_roles,
  tags: [],
  url: k.url || null,
  sop_group_id: k.sopGroupId ? fbDocIdToUuid(k.sopGroupId) : null,
  version: vNum,
  version_label: vLabel,
  approval_status: k.approvalStatus || 'approved',
  approved_by: approvedBy,
  approved_at: ts(k.approvedAt),
  created_by: createdBy,
  created_at: ts(k.createdAt) || new Date().toISOString(),
  updated_at: ts(k.updatedAt) || ts(k.createdAt) || new Date().toISOString(),
};

console.log('\nInserting row:');
console.log({
  title: row.title, category: row.category, visibility: row.visibility,
  visible_to_roles: row.visible_to_roles, url: row.url, version: row.version,
});

const { error } = await sb.from('kb_articles').insert(row);
if (error) {
  console.error('Insert failed:', error);
  process.exit(1);
}
console.log('\nInserted successfully. v2 id:', row.id);
