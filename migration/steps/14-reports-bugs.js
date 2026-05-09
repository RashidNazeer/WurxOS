// Step 14: weeklyReports (62) + biWeeklyReports (1) + bugReports (33) + messages.
//
// Reports — v2 has a unified `reports` table with type='weekly'|'biweekly'.
// All report content (sections, insights, top creators, etc.) goes into
// the `data` jsonb field. Top-level columns hold metadata only.
//
//   v1 weeklyReport / biWeeklyReport     v2 reports row
//     id (random)                          id (uuidv5)
//     brandId                              brand_id (mapped)
//     submittedBy / createdBy              author_id (mapped, prefer createdBy)
//     status                               status (draft/submitted/verified/approved)
//     weekStart / periodStart              period_start
//     weekEnd / periodEnd                  period_end
//     week (number)                        period_number
//     year                                 period_year
//     month                                period_month
//     weekLabel / periodLabel              period_label
//     submittedAt/By, verifiedAt/By,       submitted_at/by, verified_at/by,
//       approvedAt/By, rejectedAt/By,       approved_at/by, rejected_at/by,
//       rejectionNote                       rejection_note
//     <all other content fields>           data { ...all the section content }
//
// Bug reports + messages: straightforward 1:1 mapping.

import { fbDb } from '../lib/firebase.js';
import { sb } from '../lib/supabase.js';
import { fbUidToUuid, fbDocIdToUuid } from '../lib/uid.js';
import { makeLogger } from '../lib/log.js';
import { deleteOrphans } from '../lib/sync.js';

const log = makeLogger('14-reports-bugs');
const APPLY = process.env.MIGRATION_APPLY === '1';

const VALID_REPORT_STATUS = new Set(['draft','submitted','verified','approved']);
const VALID_BUG_TYPE = new Set(['ui','functional','performance','data','auth','other']);
const VALID_BUG_STATUS = new Set(['open','in_progress','fixed','closed','temp_closed','wont_fix']);
const VALID_PRIORITY = new Set(['low','medium','high','critical']);

function ts(v) {
  if (!v) return null;
  if (v._seconds) return new Date(v._seconds * 1000).toISOString();
  if (typeof v === 'string') {
    const t = new Date(v);
    return isNaN(t) ? null : t.toISOString();
  }
  if (v.toDate) return v.toDate().toISOString();
  return null;
}

// Pull data fields out of the v1 doc (everything except top-level metadata).
function buildData(x) {
  const META_KEYS = new Set([
    'brandId','brandName','status','createdBy','createdByName',
    'submittedBy','submittedByName','submittedAt',
    'verifiedBy','verifiedByName','verifiedAt',
    'approvedBy','approvedByName','approvedAt',
    'rejectedBy','rejectedByName','rejectedAt','rejectionNote',
    'reopenedBy','reopenedByName','reopenedAt',
    'weekStart','weekEnd','weekLabel','week','year','month',
    'periodStart','periodEnd','periodLabel','periodNumber',
    'monthKey','monthLabel',
    'lastEditedBy','lastEditedByName',
    'sectionsEnabled',  // promoted to its own column on v2 (mig 129)
    'createdAt','updatedAt',
  ]);
  const out = {};
  for (const [k, v] of Object.entries(x)) {
    if (!META_KEYS.has(k)) out[k] = v;
  }
  return out;
}

// Convert "YYYY-MM" → ["YYYY-MM-01", "YYYY-MM-{lastDay}"]. Used for
// monthly reports where v1 stores only monthKey, but v2's reports
// table has NOT NULL period_start / period_end.
function monthKeyToRange(monthKey) {
  if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) return null;
  const [y, m] = monthKey.split('-').map(Number);
  const start = `${monthKey}-01`;
  // Last day of month: day 0 of next month
  const last = new Date(y, m, 0).getDate();
  const end = `${monthKey}-${String(last).padStart(2, '0')}`;
  return { start, end };
}

function buildReportRow(d, type, profileIds, brandIds) {
  const x = d.data();
  if (!x.brandId) return { skip: 'no brandId' };
  const brandUuid = fbDocIdToUuid(x.brandId);
  if (!brandIds.has(brandUuid)) return { skip: `brand ${x.brandId} not migrated` };

  // Author: prefer createdBy, fall back to submittedBy
  const authorRaw = x.createdBy || x.submittedBy;
  const author = authorRaw ? fbUidToUuid(authorRaw) : null;
  if (!author || !profileIds.has(author)) return { skip: `author ${authorRaw} not in profiles` };

  let periodStart, periodEnd, periodNumber, periodLabel;
  if (type === 'weekly') {
    periodStart = x.weekStart;
    periodEnd   = x.weekEnd;
    periodNumber = x.week ?? null;
    periodLabel  = x.weekLabel ?? null;
  } else if (type === 'monthly') {
    // v1 monthly reports carry only monthKey (e.g. "2026-03") + monthLabel.
    // v2's reports table requires period_start / period_end NOT NULL, so
    // synthesize them from monthKey.
    const range = monthKeyToRange(x.monthKey);
    if (!range) return { skip: `bad monthKey ${x.monthKey}` };
    periodStart = range.start;
    periodEnd   = range.end;
    periodNumber = x.month ?? null;
    periodLabel  = x.monthLabel ?? null;
  } else {
    periodStart = x.periodStart || x.weekStart;
    periodEnd   = x.periodEnd   || x.weekEnd;
    periodNumber = x.periodNumber ?? null;
    periodLabel  = x.periodLabel ?? null;
  }
  if (!periodStart || !periodEnd) return { skip: `missing period dates` };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)) {
    return { skip: `bad period dates ${periodStart}/${periodEnd}` };
  }

  const status = VALID_REPORT_STATUS.has(x.status) ? x.status : 'draft';

  const mapActor = (uid) => {
    if (!uid) return null;
    const u = fbUidToUuid(uid);
    return profileIds.has(u) ? u : null;
  };

  const legacyId =
    type === 'weekly'   ? 'wr:'  + d.id :
    type === 'biweekly' ? 'bw:'  + d.id :
                          'mr:'  + d.id;

  const row = {
    id: fbDocIdToUuid(legacyId),
    legacy_id: legacyId,
    brand_id: brandUuid,
    author_id: author,
    type,
    period_number: periodNumber,
    period_start: periodStart,
    period_end: periodEnd,
    period_year: x.year ?? null,
    period_month: x.month ?? null,
    period_label: periodLabel,
    status,
    data: buildData(x),
    submitted_at: ts(x.submittedAt),
    submitted_by: mapActor(x.submittedBy),
    verified_at: ts(x.verifiedAt),
    verified_by: mapActor(x.verifiedBy),
    approved_at: ts(x.approvedAt),
    approved_by: mapActor(x.approvedBy),
    rejected_at: ts(x.rejectedAt),
    rejected_by: mapActor(x.rejectedBy),
    rejection_note: x.rejectionNote || null,
    reopened_at: ts(x.reopenedAt),
    reopened_by: mapActor(x.reopenedBy),
    created_at: ts(x.submittedAt) || ts(x.createdAt) || new Date().toISOString(),
    updated_at: ts(x.updatedAt) || ts(x.submittedAt) || new Date().toISOString(),
  };

  // Monthly reports carry sectionsEnabled (mig 129 column on v2).
  // Always send a value (NOT NULL constraint) — empty {} for non-monthly
  // and for monthly rows that didn't have sectionsEnabled set in v1.
  row.sections_enabled =
    (type === 'monthly' && x.sectionsEnabled && typeof x.sectionsEnabled === 'object')
      ? x.sectionsEnabled
      : {};

  // last_edited_by — v2 mig 121 added these columns.
  const lastEdited = mapActor(x.lastEditedBy);
  if (lastEdited) {
    row.last_edited_by = lastEdited;
    row.last_edited_at = ts(x.updatedAt) || ts(x.submittedAt) || null;
  }

  return { row };
}

async function main() {
  log.info(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);

  const [wSnap, bwSnap, mSnap, bugSnap, profsRes, brandsRes] = await Promise.all([
    fbDb.collection('weeklyReports').get(),
    fbDb.collection('biWeeklyReports').get(),
    fbDb.collection('monthlyReports').get(),
    fbDb.collection('bugReports').get(),
    sb.from('profiles').select('id'),
    sb.from('brands').select('id'),
  ]);
  const profileIds = new Set((profsRes.data || []).map((r) => r.id));
  const brandIds = new Set((brandsRes.data || []).map((r) => r.id));

  log.info(`v1 weeklyReports: ${wSnap.size}, biWeeklyReports: ${bwSnap.size}, monthlyReports: ${mSnap.size}, bugReports: ${bugSnap.size}`);

  // ----- Reports -----
  const reportRows = [];
  const skippedR = [];
  for (const d of wSnap.docs) {
    const r = buildReportRow(d, 'weekly', profileIds, brandIds);
    if (r.skip) skippedR.push({ id: d.id, src: 'weekly', reason: r.skip });
    else reportRows.push(r.row);
  }
  for (const d of bwSnap.docs) {
    const r = buildReportRow(d, 'biweekly', profileIds, brandIds);
    if (r.skip) skippedR.push({ id: d.id, src: 'biweekly', reason: r.skip });
    else reportRows.push(r.row);
  }
  for (const d of mSnap.docs) {
    const r = buildReportRow(d, 'monthly', profileIds, brandIds);
    if (r.skip) skippedR.push({ id: d.id, src: 'monthly', reason: r.skip });
    else reportRows.push(r.row);
  }

  // De-dupe on (brand_id, type, period_start) — UNIQUE constraint in v2
  const dedup = new Set();
  const finalReports = [];
  for (const r of reportRows) {
    const k = `${r.brand_id}|${r.type}|${r.period_start}`;
    if (dedup.has(k)) {
      skippedR.push({ id: r.id, src: 'dup', reason: `duplicate (brand,type,period_start)` });
      continue;
    }
    dedup.add(k);
    finalReports.push(r);
  }

  // ----- Bug reports -----
  const bugRows = [];
  const messageRows = [];
  const skippedB = [];
  for (const d of bugSnap.docs) {
    const x = d.data();
    const reporter = x.reporterUid ? fbUidToUuid(x.reporterUid) : null;
    if (!reporter || !profileIds.has(reporter)) {
      skippedB.push({ id: d.id, reason: `reporter ${x.reporterUid} not in profiles` });
      continue;
    }
    const bugLegacy = 'bug:' + d.id;
    const bugId = fbDocIdToUuid(bugLegacy);
    bugRows.push({
      id: bugId,
      legacy_id: bugLegacy,
      bug_type: VALID_BUG_TYPE.has(x.bugType) ? x.bugType : 'other',
      priority: VALID_PRIORITY.has(x.priority) ? x.priority : 'medium',
      title: (x.title || '(untitled)').slice(0, 500),
      description: x.description || '',
      status: VALID_BUG_STATUS.has(x.status) ? x.status : 'open',
      reporter_id: reporter,
      reporter_name: x.reporterName || null,
      reporter_role: x.reporterRole || null,
      dev_notes: x.devNotes || null,
      created_at: ts(x.createdAt) || new Date().toISOString(),
      updated_at: ts(x.updatedAt) || ts(x.createdAt) || new Date().toISOString(),
    });

    // Messages subcollection
    const msgSnap = await fbDb.collection('bugReports').doc(d.id).collection('messages').get();
    for (const m of msgSnap.docs) {
      const mx = m.data();
      // senderUid 'dev' means a developer typed it; fall back to first developer in profiles.
      let sender = null;
      if (mx.senderUid && mx.senderUid !== 'dev') {
        const su = fbUidToUuid(mx.senderUid);
        if (profileIds.has(su)) sender = su;
      }
      // Skip messages we can't attribute — bug_report_messages requires sender_id NOT NULL
      if (!sender) continue;
      messageRows.push({
        id: fbDocIdToUuid('bugmsg:' + d.id + ':' + m.id),
        bug_id: bugId,
        sender_id: sender,
        // We don't know v2's exact text column name yet; we'll probe in apply path.
        message: mx.text || '',
        created_at: ts(mx.createdAt) || new Date().toISOString(),
      });
    }
  }

  log.info(`Reports ready: ${finalReports.length} (skipped ${skippedR.length})`);
  log.info(`Bugs ready:    ${bugRows.length} (skipped ${skippedB.length})`);
  log.info(`Bug messages:  ${messageRows.length}`);
  if (skippedR.length) skippedR.slice(0, 10).forEach((s) => log.warn(`  ${s.src} ${s.id}: ${s.reason}`));
  if (skippedB.length) skippedB.forEach((s) => log.warn(`  bug ${s.id}: ${s.reason}`));

  const byStatus = finalReports.reduce((m, r) => { m[r.status] = (m[r.status]||0)+1; return m; }, {});
  log.info(`Reports by status: ${JSON.stringify(byStatus)}`);

  if (!APPLY) {
    log.info('DRY-RUN — no writes. Re-run with --apply to execute.');
    return;
  }

  // Reports
  if (finalReports.length) {
    const CHUNK = 50;
    let ok = 0;
    for (let i = 0; i < finalReports.length; i += CHUNK) {
      const chunk = finalReports.slice(i, i + CHUNK);
      const { error } = await sb.from('reports').upsert(chunk, { onConflict: 'id' });
      if (error) { log.error(`reports chunk ${i/CHUNK}: ${error.message}`); process.exit(1); }
      ok += chunk.length;
      log.info(`  reports ${ok}/${finalReports.length}`);
    }
  }

  // Bug reports
  if (bugRows.length) {
    const { error } = await sb.from('bug_reports').upsert(bugRows, { onConflict: 'id' });
    if (error) { log.error(`bug_reports: ${error.message}`); process.exit(1); }
    log.info(`bug_reports upserted: ${bugRows.length}`);
  }

  // Bug messages — figure out the text column name first.
  if (messageRows.length) {
    let textCol = 'message';
    const { error: probe } = await sb.from('bug_report_messages').select('message').limit(1);
    if (probe) {
      // try alternatives
      for (const c of ['text','body','content']) {
        const { error } = await sb.from('bug_report_messages').select(c).limit(1);
        if (!error) { textCol = c; break; }
      }
    }
    if (textCol !== 'message') {
      messageRows.forEach((r) => { r[textCol] = r.message; delete r.message; });
    }
    const { error } = await sb.from('bug_report_messages').upsert(messageRows, { onConflict: 'id' });
    if (error) { log.error(`bug_report_messages (${textCol}): ${error.message}`); process.exit(1); }
    log.info(`bug_report_messages upserted: ${messageRows.length} (text col: ${textCol})`);
  }

  await deleteOrphans('reports',     finalReports.map((r) => r.legacy_id), log);
  await deleteOrphans('bug_reports', bugRows.map((r) => r.legacy_id),       log);
  log.info('Step 14 complete.');
}

main().catch((e) => {
  log.error(e.stack || e.message);
  process.exit(1);
});
