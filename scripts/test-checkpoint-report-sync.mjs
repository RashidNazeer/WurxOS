// ============================================================
// Tests for src/lib/checkpointReportSync.js: what a VERIFIED weekly report writes into the weekly
// checkpoint, and the rule that it never overwrites what a person typed.
//
//   node scripts/test-checkpoint-report-sync.mjs
//
// No network, no DB.
// ============================================================
import assert from 'node:assert/strict';

const S = await import(new URL('../src/lib/checkpointReportSync.js', import.meta.url).href);
const M = await import(new URL('../src/lib/checkpointModel.js', import.meta.url).href);

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log('  PASS  ' + name); pass++; }
  catch (e) { console.log('  FAIL  ' + name + '\n        ' + e.message); fail++; }
};

const WEEK = '2026-11-01';   // a Sunday-start report week
const report = (over = {}) => ({
  id: 'r1', weekStart: WEEK, status: 'verified', verifiedAt: { toDate: () => new Date('2026-11-09T10:00:00Z') },
  overallPerformance: { gmv: '12000', orders: '300', samplesApproved: '40', roi: '2.5', videosPosted: '55' },
  overallNotes: { samplesApproved: '120' },
  gmvMax: [{ spend: '1000', gmv: '3000', orders: '60' }, { spend: '500.5', gmv: '1500', orders: '30' }],
  productHighlights: [{ productName: 'Serum', samplesApprovedWeek: '12' }, { productName: '', samplesApprovedWeek: '' }],
  topVideos: [{ creatorName: '@amy', gmv: '800' }, { creatorName: '', gmv: '' }],
  ...over,
});
const n2 = { id: 'r0', weekStart: '2026-10-18', status: 'approved', overallPerformance: { samplesApproved: '33' } };

// ── only a verified report flows ────────────────────────────────────
t('a draft or submitted report writes nothing and is flagged pending', () => {
  for (const status of ['draft', 'submitted']) {
    const p = S.buildReportPatch([report({ status })], WEEK);
    assert.equal(p.meta.reportFound, false);
    assert.equal(p.meta.reportPending, true);
    assert.deepEqual(p.scalars, {});
  }
});
t('a verified and an approved report both flow', () => {
  assert.equal(S.buildReportPatch([report()], WEEK).meta.reportFound, true);
  assert.equal(S.buildReportPatch([report({ status: 'approved' })], WEEK).meta.reportFound, true);
});
t('no report for the week: not found, not pending', () => {
  const p = S.buildReportPatch([], WEEK);
  assert.equal(p.meta.reportFound, false);
  assert.equal(p.meta.reportPending, false);
});
t('the N-2 figure comes from the verified N-2 report only', () => {
  assert.equal(S.buildReportPatch([report(), n2], WEEK).scalars['funnel.approvedN2'], '33');
  assert.equal(S.buildReportPatch([report(), { ...n2, status: 'draft' }], WEEK).scalars['funnel.approvedN2'], undefined);
});

// ── the mapping ─────────────────────────────────────────────────────
t('the common fields are mapped from the report', () => {
  const p = S.buildReportPatch([report(), n2], WEEK);
  assert.equal(p.scalars['snapshot.kpis.gmv.cur'], '12000');
  assert.equal(p.scalars['snapshot.kpis.roi.cur'], '2.5');
  assert.equal(p.scalars['snapshot.kpis.orders.cur'], '300');
  assert.equal(p.scalars['traffic.orders'], '300');
  assert.equal(p.scalars['snapshot.kpis.videosLive.cur'], '55');
  assert.equal(p.scalars['funnel.approved'], '40');
  assert.equal(p.scalars['samples.approvedThisWeek'], '40');
  assert.equal(p.scalars['samples.mtdApproved'], '120');
  assert.equal(p.scalars['paid.spend'], '1500.5');
  assert.equal(p.scalars['paid.grossRevenue'], '4500');
  assert.equal(p.scalars['paid.skuOrders'], '90');
  assert.equal(p.scalars['snapshot.kpis.costPerOrder.cur'], '16.67');   // 1500.5 / 90
  assert.deepEqual(p.arrays['samples.products'], [{ name: 'Serum', count: '12' }]);
  assert.deepEqual(p.arrays['traffic.topVideos'], [{ creator: '@amy', angle: '', gmv: '800' }]);
});
t('fields that are NOT the same figure in both documents are never written', () => {
  const p = S.buildReportPatch([report(), n2], WEEK);
  for (const path of ['funnel.videosLive', 'snapshot.kpis.ctor.cur', 'snapshot.kpis.rating.cur', 'traffic.impressions',
    'traffic.clicks', 'funnel.affiliateOrders', 'samples.requestsReceived', 'funnel.sampleRequests']) {
    assert.equal(p.scalars[path], undefined, path);
  }
});
t('no GMV Max rows: the paid fields stay empty rather than becoming 0', () => {
  const p = S.buildReportPatch([report({ gmvMax: [] })], WEEK);
  assert.equal(p.scalars['paid.spend'], undefined);
  assert.equal(p.scalars['snapshot.kpis.costPerOrder.cur'], undefined);
});
t('the stamp carries the report id and its verified time', () => {
  const p = S.buildReportPatch([report()], WEEK);
  assert.equal(p.meta.reportId, 'r1');
  assert.equal(p.meta.reportVerifiedAt, '2026-11-09T10:00:00.000Z');
});

// ── the merge rule: never overwrite a person ────────────────────────
const fresh = () => M.EMPTY_CHECKPOINT();

t('a blank checkpoint is filled, mirrored fields included', () => {
  const p = S.buildReportPatch([report()], WEEK);
  const r = S.mergeReportPatchInto(fresh(), p);
  assert.equal(r.data.snapshot.kpis.gmv.cur, '12000');
  assert.equal(r.data.traffic.orders, '300');
  assert.equal(r.data.funnel.approved, '40');
  assert.equal(r.data.samples.approvedThisWeek, '40');
  assert.equal(r.data.paid.spend, '1500.5');
  assert.equal(r.data.snapshot.kpis.gmvMaxSpend.cur, '1500.5');       // mirror of paid.spend
  assert.ok(r.filled >= 12 && r.kept === 0 && r.changed);
  assert.equal(JSON.parse(r.data._autofill.values)['snapshot.kpis.gmv.cur'], '12000');
});
t('what the APC typed is kept, and counted', () => {
  const d = fresh(); d.snapshot.kpis.gmv.cur = '11111'; d.funnel.approved = '99';
  const r = S.mergeReportPatchInto(d, S.buildReportPatch([report()], WEEK));
  assert.equal(r.data.snapshot.kpis.gmv.cur, '11111');
  assert.equal(r.data.funnel.approved, '99');
  assert.equal(r.data.samples.approvedThisWeek, '99');                // the blank mirror member follows the APC's number, never the report's
  assert.ok(r.kept >= 1);
});
t('a value the sync wrote earlier is refreshed when the report changes', () => {
  const first = S.mergeReportPatchInto(fresh(), S.buildReportPatch([report()], WEEK));
  const corrected = report({ overallPerformance: { gmv: '12500', orders: '300', samplesApproved: '40', roi: '2.5', videosPosted: '55' } });
  const second = S.mergeReportPatchInto(first.data, S.buildReportPatch([corrected], WEEK));
  assert.equal(second.data.snapshot.kpis.gmv.cur, '12500');
  assert.equal(second.kept, 0);
});
t('a value the APC edited after the sync is not refreshed', () => {
  const first = S.mergeReportPatchInto(fresh(), S.buildReportPatch([report()], WEEK));
  first.data.snapshot.kpis.gmv.cur = '13000';                          // the APC's own correction
  const corrected = report({ overallPerformance: { gmv: '12500', orders: '300', samplesApproved: '40', roi: '2.5', videosPosted: '55' } });
  const second = S.mergeReportPatchInto(first.data, S.buildReportPatch([corrected], WEEK));
  assert.equal(second.data.snapshot.kpis.gmv.cur, '13000');
  assert.ok(second.kept >= 1);
});
t('running the merge twice changes nothing the second time', () => {
  const p = S.buildReportPatch([report()], WEEK);
  const a = S.mergeReportPatchInto(fresh(), p);
  const b = S.mergeReportPatchInto(a.data, p);
  assert.equal(b.changed, false);
  assert.equal(b.filled, 0);
  assert.deepEqual(b.data, a.data);
});
t('arrays: blank placeholder rows are replaced, a typed list is kept', () => {
  const p = S.buildReportPatch([report()], WEEK);
  const blank = S.mergeReportPatchInto(fresh(), p);
  assert.deepEqual(blank.data.samples.products, [{ name: 'Serum', count: '12' }]);
  const d = fresh(); d.samples.products = [{ name: 'My own', count: '7' }];
  const typed = S.mergeReportPatchInto(d, p);
  assert.deepEqual(typed.data.samples.products, [{ name: 'My own', count: '7' }]);
});
t('the stamp survives hydrate-style loading (strings only)', () => {
  const r = S.mergeReportPatchInto(fresh(), S.buildReportPatch([report()], WEEK));
  for (const v of Object.values(r.data._autofill)) assert.equal(typeof v, 'string');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
