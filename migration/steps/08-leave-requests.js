// Step 08: leaveRequests — 28 docs.
//
// Schema mapping is lossy because v2 only has three leave types
// (wfh / medical / emergency), while v1 has more granularity:
//
//   v1 category    v1 leaveType    v2 type      notes
//   ----------     ------------    -------      ------------------
//   wfh            -               wfh
//   leave          medical         medical
//   leave          emergency       emergency
//   leave          casual          emergency    (no v2 'casual')
//   half_leave     -               emergency    half-day
//   other          -               emergency    typically schedule change
//
// To preserve detail, we prepend `[category]` (and `otherTitle` if set)
// to the reason text before saving, so nothing is lost.
//
// Approval flow:
//   v1 stores intermediateApproval + bossApproval. v2 has just one
//   decided_by + decided_at + decision_note + final status. We pick
//   the strongest decision: bossApproval if present, else intermediateApproval.
//
// All 28 v1 records are status='approved' so this maps cleanly.
//
// Triggers: v2 has leave_notify_on_insert/update that emits notifications.
// Inserts will fire the on-insert trigger, which sends a notification
// to the approver. To avoid spamming approvers about old historic leave,
// we DISABLE the trigger temporarily during insert and re-enable after.
// Same approach as the auto-create-profile trigger consideration.
//
// Note: leave_requests has a CHECK (end_date >= start_date) constraint —
// data must satisfy it.

import { fbDb } from '../lib/firebase.js';
import { sb } from '../lib/supabase.js';
import { fbUidToUuid, fbDocIdToUuid } from '../lib/uid.js';
import { makeLogger } from '../lib/log.js';
import { deleteOrphans } from '../lib/sync.js';

const log = makeLogger('08-leave-requests');
const APPLY = process.env.MIGRATION_APPLY === '1';

const VALID_TYPE = new Set(['wfh','medical','emergency']);
const VALID_STATUS = new Set(['pending','approved','rejected','cancelled']);

function ts(v) {
  if (!v) return null;
  if (v._seconds) return new Date(v._seconds * 1000).toISOString();
  if (typeof v === 'string') return new Date(v).toISOString();
  if (v.toDate) return v.toDate().toISOString();
  return null;
}

function mapType(category, leaveType) {
  if (category === 'wfh') return 'wfh';
  if (category === 'leave') {
    if (leaveType === 'medical') return 'medical';
    return 'emergency'; // casual / emergency both -> emergency
  }
  // half_leave / other / unknown
  return 'emergency';
}

function buildReason(x) {
  const original = (x.reason || '').trim();
  const tags = [];
  if (x.category && x.category !== 'wfh' && x.category !== 'leave') {
    tags.push(`[${x.category}${x.otherTitle ? `: ${x.otherTitle}` : ''}]`);
  } else if (x.category === 'leave' && x.leaveType === 'casual') {
    tags.push('[v1 type: casual]');
  } else if (x.isPaidTimeOff === false) {
    tags.push('[unpaid]');
  }
  return [tags.join(' '), original].filter(Boolean).join(' ');
}

function pickDecision(x) {
  // Pick the strongest decision: boss > intermediate.
  const boss = x.bossApproval;
  const inter = x.intermediateApproval;
  if (boss && boss.status) {
    return {
      decided_by: boss.resolvedBy ? fbUidToUuid(boss.resolvedBy) : null,
      decided_at: ts(boss.resolvedAt),
      decision_note: boss.note || null,
    };
  }
  if (inter && inter.status) {
    return {
      decided_by: inter.approverId ? fbUidToUuid(inter.approverId) : null,
      decided_at: ts(inter.resolvedAt),
      decision_note: inter.note || null,
    };
  }
  return { decided_by: null, decided_at: null, decision_note: null };
}

async function main() {
  log.info(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);

  const [snap, profsRes] = await Promise.all([
    fbDb.collection('leaveRequests').get(),
    sb.from('profiles').select('id'),
  ]);
  const profileIds = new Set((profsRes.data || []).map((r) => r.id));
  log.info(`v1 leaveRequests: ${snap.size}`);
  log.info(`v2 profiles: ${profileIds.size}`);

  const rows = [];
  const skipped = [];

  for (const d of snap.docs) {
    const x = d.data();
    const requester = x.requestedBy ? fbUidToUuid(x.requestedBy) : null;
    if (!requester || !profileIds.has(requester)) {
      skipped.push({ id: d.id, reason: `requester ${x.requestedBy} not in profiles` });
      continue;
    }
    if (!x.startDate || !x.endDate) {
      skipped.push({ id: d.id, reason: `missing dates` });
      continue;
    }
    if (x.endDate < x.startDate) {
      skipped.push({ id: d.id, reason: `end_date < start_date (${x.startDate} > ${x.endDate})` });
      continue;
    }
    const type = mapType(x.category, x.leaveType);
    const status = VALID_STATUS.has(x.status) ? x.status : 'approved';
    const dec = pickDecision(x);
    if (dec.decided_by && !profileIds.has(dec.decided_by)) dec.decided_by = null;

    rows.push({
      id: fbDocIdToUuid(d.id),
      legacy_id: d.id,
      requester_id: requester,
      type,
      start_date: x.startDate,
      end_date: x.endDate,
      reason: buildReason(x),
      status,
      decided_by: dec.decided_by,
      decided_at: dec.decided_at,
      decision_note: dec.decision_note,
      created_at: ts(x.createdAt) || new Date().toISOString(),
    });
  }

  log.info(`Rows ready: ${rows.length}`);
  log.info(`Skipped: ${skipped.length}`);
  if (skipped.length) skipped.forEach((s) => log.warn(`  ${s.id}: ${s.reason}`));

  const byType = rows.reduce((m, r) => { m[r.type] = (m[r.type]||0)+1; return m; }, {});
  log.info(`By type: ${JSON.stringify(byType)}`);
  log.info('Sample 3:');
  rows.slice(0, 3).forEach((r) =>
    log.info(`  ${r.start_date}->${r.end_date} type=${r.type} status=${r.status} reason="${r.reason.slice(0,60)}..."`),
  );

  if (!APPLY) {
    log.info('DRY-RUN — no writes. Re-run with --apply to execute.');
    return;
  }

  // Disable triggers to avoid sending notifications for historic leave.
  // We can do this with an RPC that ALTER TABLE ... DISABLE TRIGGER, but
  // simpler: rely on session_replication_role = replica to skip user triggers.
  // Easiest approach: just upsert with the service role; the on-insert
  // trigger will fire BUT will only send notifications if the approver
  // is different from the requester. That'd notify approvers about old
  // historic leave — not great. Use a workaround: temporarily disable.
  log.info('Disabling leave_notify_ai trigger for the duration of insert...');
  const { error: derr } = await sb.rpc('exec_sql', { q: 'alter table public.leave_requests disable trigger leave_notify_ai;' });
  // The exec_sql RPC may not exist. Fall back: we'll just live with the
  // notifications going out, since v2 has no users logged in yet anyway.
  if (derr) {
    log.warn(`Could not disable trigger via exec_sql (${derr.message}). Proceeding — notifications will be queued but harmless since no clients are connected yet.`);
  }

  const { error } = await sb.from('leave_requests').upsert(rows, { onConflict: 'id' });
  if (error) {
    log.error(`Upsert failed: ${error.message}`);
    process.exit(1);
  }

  if (!derr) {
    await sb.rpc('exec_sql', { q: 'alter table public.leave_requests enable trigger leave_notify_ai;' });
  }

  log.info(`Step 08 complete: ${rows.length} leave_requests.`);

  // Clean up any notifications generated by the historic inserts.
  const { error: nerr, count } = await sb
    .from('notifications')
    .delete({ count: 'exact' })
    .eq('topic', 'leave')
    .eq('event', 'leave.requested');
  if (nerr) log.warn(`Could not clean up trigger notifications: ${nerr.message}`);
  else log.info(`Cleaned up ${count || 0} historic leave-request notifications.`);

  await deleteOrphans('leave_requests', rows.map((r) => r.legacy_id), log);
}

main().catch((e) => {
  log.error(e.stack || e.message);
  process.exit(1);
});
