// Step 05: knowledgeBase — 103 articles.
//
// v1 KB doc                    v2 kb_articles row
//   id                          id (uuidv5)
//   title                       title
//   url                         url
//   description                 (no v2 column — folded into body)
//   tab                         category
//   visibility.type             visibility   (everyone -> office, roles -> role)
//   visibility.roles            visible_to_roles (text[])
//   visibility.userIds          (no v2 column — dropped, role-based only in v2)
//   sopGroupId                  sop_group_id
//   version (string)            version (int) + version_label (text)
//   createdBy (fb uid)          created_by (mapped)
//   approvalStatus              approval_status
//   approvedBy (fb uid)         approved_by (mapped)
//   approvedAt                  approved_at
//   createdAt / updatedAt       created_at / updated_at
//
// Notes:
//   - v1 articles are external Google-Drive links — body stays empty.
//   - v1 visibility 'roles' -> v2 'role'; v1 'everyone' -> v2 'office'.
//   - v1 version is a string like "1.0" / "1". We try to parseInt for
//     v2's int `version` and put the original string in `version_label`.
//   - userId-based visibility (`visibility.userIds`) is not modeled in
//     v2 — those articles fall back to the role list (or empty -> 'office'
//     if no roles).

import { fbDb } from '../lib/firebase.js';
import { sb } from '../lib/supabase.js';
import { fbUidToUuid, fbDocIdToUuid } from '../lib/uid.js';
import { makeLogger } from '../lib/log.js';
import { deleteOrphans } from '../lib/sync.js';

const log = makeLogger('05-kb');
const APPLY = process.env.MIGRATION_APPLY === '1';

const VALID_ROLES = new Set(['boss','ol','tl','pctl','apc','ipc','developer']);

function ts(v) {
  if (!v) return null;
  if (v._seconds) return new Date(v._seconds * 1000).toISOString();
  if (v.toDate) return v.toDate().toISOString();
  return null;
}

function mapVisibility(visObj) {
  // Returns { visibility, visible_to_roles }
  if (!visObj || typeof visObj !== 'object') {
    return { visibility: 'office', visible_to_roles: [] };
  }
  const t = visObj.type;
  if (t === 'roles' && Array.isArray(visObj.roles) && visObj.roles.length > 0) {
    const roles = visObj.roles
      .map((r) => r === 'dev' ? 'developer' : r)
      .filter((r) => VALID_ROLES.has(r));
    if (roles.length > 0) return { visibility: 'role', visible_to_roles: roles };
    return { visibility: 'office', visible_to_roles: [] };
  }
  // 'everyone' or anything else -> office
  return { visibility: 'office', visible_to_roles: [] };
}

function parseVersion(s) {
  if (!s) return { num: 1, label: null };
  const str = String(s).trim();
  // Try simple integer
  const m = str.match(/^(\d+)/);
  const num = m ? parseInt(m[1], 10) : 1;
  // version_label keeps the original string only if it's not just "1"/"1.0"
  const label = /^\d+(\.0+)?$/.test(str) ? null : str;
  return { num: num || 1, label };
}

async function main() {
  log.info(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);

  const [snap, profsRes] = await Promise.all([
    fbDb.collection('knowledgeBase').get(),
    sb.from('profiles').select('id'),
  ]);
  const profileIds = new Set((profsRes.data || []).map((r) => r.id));
  log.info(`v1 KB: ${snap.size}`);
  log.info(`v2 profiles: ${profileIds.size}`);

  const rows = [];
  const skipped = [];

  for (const d of snap.docs) {
    const k = d.data();
    const createdBy = k.createdBy ? fbUidToUuid(k.createdBy) : null;
    if (!createdBy || !profileIds.has(createdBy)) {
      skipped.push({ id: d.id, title: k.title, reason: `createdBy ${k.createdBy} not in profiles` });
      continue;
    }
    const vis = mapVisibility(k.visibility);
    const { num: vNum, label: vLabel } = parseVersion(k.version);

    let approvedBy = k.approvedBy ? fbUidToUuid(k.approvedBy) : null;
    if (approvedBy && !profileIds.has(approvedBy)) approvedBy = null;

    rows.push({
      id: fbDocIdToUuid(d.id),
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
    });
  }

  log.info(`Rows ready: ${rows.length}`);
  log.info(`Skipped: ${skipped.length}`);
  if (skipped.length) skipped.forEach((s) => log.warn(`  ${s.id} (${s.title}): ${s.reason}`));

  // Distribution
  const byCat = rows.reduce((m, r) => { m[r.category] = (m[r.category]||0)+1; return m; }, {});
  const byVis = rows.reduce((m, r) => { m[r.visibility] = (m[r.visibility]||0)+1; return m; }, {});
  log.info(`By category: ${JSON.stringify(byCat)}`);
  log.info(`By visibility: ${JSON.stringify(byVis)}`);
  log.info(`With sop_group_id: ${rows.filter((r) => r.sop_group_id).length}`);
  log.info(`Approved: ${rows.filter((r) => r.approval_status === 'approved').length}`);

  log.info('Sample 3:');
  rows.slice(0, 3).forEach((r) =>
    log.info(`  "${r.title}" cat=${r.category} vis=${r.visibility} v=${r.version} sop=${r.sop_group_id ? 'y' : 'n'}`),
  );

  if (!APPLY) {
    log.info('DRY-RUN — no writes. Re-run with --apply to execute.');
    return;
  }

  // Bypass insert RLS via service role; insert in chunks.
  const CHUNK = 50;
  let ok = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await sb.from('kb_articles').upsert(chunk, { onConflict: 'id' });
    if (error) {
      log.error(`Chunk ${i / CHUNK}: ${error.message}`);
      process.exit(1);
    }
    ok += chunk.length;
    log.info(`  ${ok}/${rows.length}`);
  }
  log.info(`Step 05 upsert complete: ${ok} kb_articles.`);

  await deleteOrphans('kb_articles', rows.map((r) => r.legacy_id), log);
  log.info('Step 05 complete.');
}

main().catch((e) => {
  log.error(e.stack || e.message);
  process.exit(1);
});
