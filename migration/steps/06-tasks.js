// Step 06: tasks — generalTasks (54) + brand-nested tasks (216) = 270.
//
// v1 generalTasks doc          v2 tasks row
//   id                          id (uuidv5)
//   title                       title
//   description                 description
//   priority (low/medium/high)  priority
//   dueDate (string or '')      due_date (date)
//   link                        link
//   category                    category (general/daily/weekly/monthly)
//   status (todo/in_progress/done) status
//   createdBy (fb uid)          created_by (mapped)
//   assigneeId (fb uid, opt)    assignee_id (mapped, fallback to created_by)
//   brandId (null for general)  brand_id (null)
//   nextResetAt                 next_reset_at (will be recomputed by trigger)
//   createdAt                   created_at
//
// Brand-nested tasks: same shape but stored under brands/{brandId}/tasks.
// The parent brand id (Firestore doc id) becomes the v2 brand_id (uuidv5).
//
// Note: v2 has triggers that recompute next_reset_at on insert based on
// the assignee's reset_schedule. For migrated tasks we let the trigger
// handle this — preserving v1's exact next_reset_at would conflict with
// the assignee's current schedule anyway.

import { fbDb } from '../lib/firebase.js';
import { sb } from '../lib/supabase.js';
import { fbUidToUuid, fbDocIdToUuid } from '../lib/uid.js';
import { makeLogger } from '../lib/log.js';
import { deleteOrphans } from '../lib/sync.js';

const log = makeLogger('06-tasks');
const APPLY = process.env.MIGRATION_APPLY === '1';

const VALID_STATUS = new Set(['todo','in_progress','done']);
const VALID_PRIORITY = new Set(['low','medium','high']);
const VALID_CATEGORY = new Set(['general','daily','weekly','monthly']);

function ts(v) {
  if (!v) return null;
  if (v._seconds) return new Date(v._seconds * 1000).toISOString();
  if (v.toDate) return v.toDate().toISOString();
  return null;
}

function buildRow(d, brandUuid, profileIds, brandIds) {
  const t = d.data();
  const createdBy = t.createdBy ? fbUidToUuid(t.createdBy) : null;
  if (!createdBy || !profileIds.has(createdBy)) {
    return { skip: `createdBy ${t.createdBy} not in profiles` };
  }
  // assignee fallback to creator
  let assignee = t.assigneeId ? fbUidToUuid(t.assigneeId) : null;
  if (!assignee || !profileIds.has(assignee)) assignee = createdBy;

  // brand_id null if it's general OR the brand wasn't migrated
  let brandId = brandUuid;
  if (brandId && !brandIds.has(brandId)) brandId = null;

  // due_date: v1 stores '' or 'YYYY-MM-DD' or empty
  let dueDate = null;
  if (typeof t.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.dueDate)) {
    dueDate = t.dueDate;
  }

  const legacyId = (brandUuid ? `brand:${d.ref.parent.parent.id}:` : 'gen:') + d.id;
  return {
    row: {
      id: fbDocIdToUuid(legacyId),
      legacy_id: legacyId,
      brand_id: brandId,
      assignee_id: assignee,
      title: (t.title || '(untitled)').slice(0, 500),
      description: t.description || null,
      status: VALID_STATUS.has(t.status) ? t.status : 'todo',
      priority: VALID_PRIORITY.has(t.priority) ? t.priority : 'medium',
      category: VALID_CATEGORY.has(t.category) ? t.category : 'general',
      due_date: dueDate,
      link: t.link || null,
      created_by: createdBy,
      created_at: ts(t.createdAt) || new Date().toISOString(),
      updated_at: ts(t.updatedAt) || ts(t.createdAt) || new Date().toISOString(),
    },
  };
}

async function main() {
  log.info(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);

  const [genSnap, brandsSnap, profsRes, brandsRes] = await Promise.all([
    fbDb.collection('generalTasks').get(),
    fbDb.collection('brands').get(),
    sb.from('profiles').select('id'),
    sb.from('brands').select('id'),
  ]);
  const profileIds = new Set((profsRes.data || []).map((r) => r.id));
  const brandIds = new Set((brandsRes.data || []).map((r) => r.id));
  log.info(`v1 generalTasks: ${genSnap.size}`);
  log.info(`v1 brands: ${brandsSnap.size}`);
  log.info(`v2 profiles: ${profileIds.size}, brands: ${brandIds.size}`);

  const rows = [];
  const skipped = [];

  // generalTasks
  for (const d of genSnap.docs) {
    const r = buildRow(d, null, profileIds, brandIds);
    if (r.skip) skipped.push({ id: d.id, src: 'gen', reason: r.skip });
    else rows.push(r.row);
  }

  // brand-nested
  for (const b of brandsSnap.docs) {
    const brandUuid = fbDocIdToUuid(b.id);
    const subSnap = await fbDb.collection('brands').doc(b.id).collection('tasks').get();
    for (const d of subSnap.docs) {
      const r = buildRow(d, brandUuid, profileIds, brandIds);
      if (r.skip) skipped.push({ id: d.id, src: 'brand:' + b.data().brandName, reason: r.skip });
      else rows.push(r.row);
    }
  }

  log.info(`Rows ready: ${rows.length}`);
  log.info(`Skipped: ${skipped.length}`);
  if (skipped.length) {
    skipped.slice(0, 8).forEach((s) => log.warn(`  ${s.src} ${s.id}: ${s.reason}`));
    if (skipped.length > 8) log.warn(`  ... and ${skipped.length - 8} more`);
  }

  // Stats
  const byCat = rows.reduce((m, r) => { m[r.category] = (m[r.category]||0)+1; return m; }, {});
  const byStatus = rows.reduce((m, r) => { m[r.status] = (m[r.status]||0)+1; return m; }, {});
  const withBrand = rows.filter((r) => r.brand_id).length;
  log.info(`By category: ${JSON.stringify(byCat)}`);
  log.info(`By status: ${JSON.stringify(byStatus)}`);
  log.info(`With brand_id: ${withBrand}, brand=null (general): ${rows.length - withBrand}`);

  log.info('Sample 3:');
  rows.slice(0, 3).forEach((r) =>
    log.info(`  "${r.title}"  cat=${r.category}  status=${r.status}  brand=${r.brand_id ? 'y' : 'n'}  due=${r.due_date || '-'}`),
  );

  if (!APPLY) {
    log.info('DRY-RUN — no writes. Re-run with --apply to execute.');
    return;
  }

  const CHUNK = 100;
  let ok = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await sb.from('tasks').upsert(chunk, { onConflict: 'id' });
    if (error) {
      log.error(`Chunk ${i / CHUNK}: ${error.message}`);
      process.exit(1);
    }
    ok += chunk.length;
    log.info(`  ${ok}/${rows.length}`);
  }
  log.info(`Step 06 upsert complete: ${ok} tasks.`);

  // Delete orphans — v2 rows whose legacy_id no longer matches any v1 doc.
  const currentLegacyIds = rows.map((r) => r.legacy_id);
  await deleteOrphans('tasks', currentLegacyIds, log);
}

main().catch((e) => {
  log.error(e.stack || e.message);
  process.exit(1);
});
