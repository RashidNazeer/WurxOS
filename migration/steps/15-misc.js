// Step 15: misc — biWeeklyAnchors (2), userReportFields (3), settings (2),
// resourcePlannerConfig (1).
//
// Skipped (no v2 schema or already-applied):
//   - clientAccess (25) + reportAccess (2): v2's report_shares is per-report
//     token, not per-client-bundle. Recreate via UI if needed.
//   - employeeOnboardings (4): no v2 onboarding feature.
//   - generalRequests (6): no v2 generic-requests table.
//   - meetingResources (1) + weeklyAgendaSessions (9) + weeklyAgendaTasks (29):
//     no v2 agenda/meeting feature.
//   - brandSwitchRequests (4): historic; the moves already took effect in v1
//     and v2's brand_assignments already reflects current state.
//   - SodaUsers/SodaGroups/SodaOtherPersons: different app.

import { fbDb } from '../lib/firebase.js';
import { sb } from '../lib/supabase.js';
import { fbUidToUuid, fbDocIdToUuid } from '../lib/uid.js';
import { makeLogger } from '../lib/log.js';

const log = makeLogger('15-misc');
const APPLY = process.env.MIGRATION_APPLY === '1';

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

async function main() {
  log.info(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);

  const [anchorsSnap, userFieldsSnap, settingsSnap, rpcSnap, profsRes, brandsRes] = await Promise.all([
    fbDb.collection('biWeeklyAnchors').get(),
    fbDb.collection('userReportFields').get(),
    fbDb.collection('settings').get(),
    fbDb.collection('resourcePlannerConfig').get(),
    sb.from('profiles').select('id'),
    sb.from('brands').select('id'),
  ]);
  const profileIds = new Set((profsRes.data || []).map((r) => r.id));
  const brandIds = new Set((brandsRes.data || []).map((r) => r.id));

  // ----- bi_weekly_anchors -----
  const anchors = [];
  for (const d of anchorsSnap.docs) {
    const x = d.data();
    const brandUuid = x.brandId ? fbDocIdToUuid(x.brandId) : null;
    if (!brandUuid || !brandIds.has(brandUuid)) {
      log.warn(`anchor ${d.id}: brand ${x.brandId} not in v2`);
      continue;
    }
    let setBy = x.setBy ? fbUidToUuid(x.setBy) : null;
    if (setBy && !profileIds.has(setBy)) setBy = null;
    anchors.push({
      brand_id: brandUuid,
      anchor_start: x.anchorStart,
      set_by: setBy,
      set_at: ts(x.setAt) || new Date().toISOString(),
    });
  }

  // ----- user_report_custom_fields -----
  // v1: { id: <uid>, customFields: [...] }
  // v2: one row per (user, field_name, sort_order)
  const userFields = [];
  for (const d of userFieldsSnap.docs) {
    const x = d.data();
    const userUuid = fbUidToUuid(d.id);
    if (!profileIds.has(userUuid)) {
      log.warn(`userReportFields ${d.id}: user not in v2`);
      continue;
    }
    const fields = Array.isArray(x.customFields) ? x.customFields : [];
    fields.forEach((f, idx) => {
      const name = typeof f === 'string' ? f : (f && (f.name || f.fieldName || f.label)) || null;
      if (!name) return;
      userFields.push({
        id: fbDocIdToUuid(`urcf:${d.id}:${idx}:${name}`),
        user_id: userUuid,
        field_name: name,
        sort_order: idx,
        created_at: new Date().toISOString(),
      });
    });
  }

  // ----- app_config (from settings) -----
  // v1 settings docs are like { id: 'leaveQuota', medical:1, emergency:1, wfh:2 }
  // v2 app_config: (key text PK, value jsonb)
  const appConfig = [];
  for (const d of settingsSnap.docs) {
    const { id: _ignore, ...rest } = { id: d.id, ...d.data() };
    // Map known v1 settings keys to v2 app_config keys.
    if (d.id === 'leaveQuota') {
      appConfig.push({
        key: 'leave_quota_default',
        value: {
          medical: rest.medical ?? 1,
          emergency: rest.emergency ?? 1,
          wfh: rest.wfh ?? 2,
        },
      });
    } else {
      // Generic fallback: store the whole doc as a single key.
      appConfig.push({
        key: `legacy_${d.id}`,
        value: rest,
      });
    }
  }

  // ----- resource_planner_config -----
  // v1 has a single 'default' doc. v2 is also single-row.
  const rpcRows = [];
  for (const d of rpcSnap.docs) {
    const x = d.data();
    let updatedBy = x.updatedBy ? fbUidToUuid(x.updatedBy) : null;
    if (updatedBy && !profileIds.has(updatedBy)) updatedBy = null;
    rpcRows.push({
      id: fbDocIdToUuid(`rpc:${d.id}`),
      target_new_brands_per_month: Number(x.targetNewBrandsPerMonth || 0),
      churn_rate: Number(x.churnRate || 0),
      min_buffer_headcount: Number(x.minBufferHeadcount || 0),
      planning_horizon_months: Number(x.planningHorizonMonths || 3),
      updated_by: updatedBy,
      updated_at: ts(x.updatedAt) || new Date().toISOString(),
    });
  }

  log.info(`bi_weekly_anchors:        ${anchors.length}`);
  log.info(`user_report_custom_fields ${userFields.length} rows (from ${userFieldsSnap.size} v1 docs)`);
  log.info(`app_config:               ${appConfig.length}`);
  log.info(`resource_planner_config:  ${rpcRows.length}`);

  if (!APPLY) {
    log.info('DRY-RUN — no writes. Re-run with --apply to execute.');
    return;
  }

  if (anchors.length) {
    const { error } = await sb.from('bi_weekly_anchors').upsert(anchors, { onConflict: 'brand_id' });
    if (error) { log.error(`anchors: ${error.message}`); process.exit(1); }
    log.info(`bi_weekly_anchors upserted: ${anchors.length}`);
  }
  if (userFields.length) {
    const { error } = await sb.from('user_report_custom_fields').upsert(userFields, { onConflict: 'id' });
    if (error) { log.error(`user_report_custom_fields: ${error.message}`); process.exit(1); }
    log.info(`user_report_custom_fields upserted: ${userFields.length}`);
  }
  if (appConfig.length) {
    const { error } = await sb.from('app_config').upsert(appConfig, { onConflict: 'key' });
    if (error) { log.warn(`app_config: ${error.message} — skipping (existing keys may be locked)`); }
    else log.info(`app_config upserted: ${appConfig.length}`);
  }
  if (rpcRows.length) {
    const { error } = await sb.from('resource_planner_config').upsert(rpcRows, { onConflict: 'id' });
    if (error) { log.error(`resource_planner_config: ${error.message}`); process.exit(1); }
    log.info(`resource_planner_config upserted: ${rpcRows.length}`);
  }

  log.info('Step 15 complete.');
}

main().catch((e) => {
  log.error(e.stack || e.message);
  process.exit(1);
});
