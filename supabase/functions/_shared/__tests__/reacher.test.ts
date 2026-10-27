// Reacher mapping tests. The fixtures are trimmed copies of REAL responses from
// Irwin Naturals' shop for the week of 18-24 Oct 2026, and the expected values are
// the ones that week's APC typed by hand into the approved report -- so a passing
// run means "the autofill reproduces what a person entered from Reacher", not
// merely "the code agrees with itself".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReportData, buildCheckpoint, spsAsOf, money, num } from '../reacher.ts';

const summary = { total_gmv: 3558.21, gmv: 2988.16, orders: 180, videos_posted: 213, samples_approved: 124, sample_requests: 467 };
const mtd = { total_gmv: 13453.94, gmv: 10696.32, orders: 735 };
const creatorsSummary = { data: { new_creators: 345, gmv_generated: 2703.25, video_posts: 189, orders: 137 } };
const creators = [
  { creator_handle: 'clarkepayne3.0', gmv: 1269.59, units_sold: 66 },
  { creator_handle: 'mariacastro202085', gmv: 378.08, units_sold: 20 },
  { creator_handle: 'affiliatelife26', gmv: 284.91, units_sold: 15 },
  { creator_handle: 'holistic.rx', gmv: 281.87, units_sold: 15 },
];
const products = [
  { product_id: '1732626145534447724', product_name: 'Cortisol Calm Kit', sc_total_gmv: 101.97, sc_orders: 3, video_count: 50 },
  { product_id: '1732471018497151084', product_name: 'Kidney & Liver Super Cleanse', sc_total_gmv: 3304.28, sc_orders: 165, video_count: 84 },
  { product_id: 'dead', product_name: 'No sales', sc_total_gmv: 0, sc_orders: 0, video_count: 9 },
];
const health = [
  { date: '2026-10-19', sps_score: 4.4 }, { date: '2026-10-24', sps_score: 4.6 }, { date: '2026-10-27', sps_score: 4.9 },
];
const run = (over: Record<string, unknown> = {}) =>
  buildReportData({ summary, mtd, creatorsSummary, creators, products, health, endDate: '2026-10-24', ...over } as any);

test('overall numbers reproduce the APC\'s hand-entered report', () => {
  const op: any = run().data.overallPerformance;
  assert.equal(op.gmv, 3558.21);
  assert.equal(op.affiliateGmv, 2988.16);
  assert.equal(op.orders, 180);
  assert.equal(op.videosPosted, 189);          // creators/summary.video_posts, NOT metrics/summary (213)
  assert.equal(op.shopPerformanceScore, 4.6);
});

test('videos come from creators/summary, not the larger metrics/summary count', () => {
  assert.equal((run().data.overallPerformance as any).videosPosted, 189);
  assert.notEqual((run().data.overallPerformance as any).videosPosted, summary.videos_posted);
});

test('samples approved and ROI are left blank: no Reacher field reproduces the APC\'s number', () => {
  const op: any = run().data.overallPerformance;
  assert.equal(op.samplesApproved, '');
  assert.equal(op.roi, '');
});

test('SPS is the score AS OF the end date, never today\'s', () => {
  assert.equal(spsAsOf(health, '2026-10-24'), 4.6);   // not the 4.9 from the 27th
  assert.equal(spsAsOf(health, '2026-10-19'), 4.4);
  assert.equal(spsAsOf(health, '2026-10-01'), '');    // nothing on or before that date
  assert.equal(spsAsOf(null, '2026-10-24'), '');
});

test('month-to-date GMV uses the MTD window; a week starting on the 1st is its own MTD', () => {
  assert.equal((run().data.overallNotes as any).gmv, 13453.94);
  assert.equal((run({ mtd: null }).data.overallNotes as any).gmv, 3558.21);
});

test('top creators: plain handle (no @), units and GMV, capped at 3, videos left blank not 0', () => {
  const tc: any[] = run().data.topCreators as any[];
  assert.equal(tc.length, 3);
  assert.deepEqual(tc[0], { name: 'clarkepayne3.0', videosPosted: '', itemsSold: 66, gmv: 1269.59, notes: '' });
  assert.ok(tc.every((c) => !c.name.startsWith('@')));
  assert.equal(tc[0].videosPosted, '');       // 0 would claim "posted nothing"
});

test('products: ranked by total GMV, zero-GMV dropped, orders used as units', () => {
  const ph: any[] = run().data.productHighlights as any[];
  assert.equal(ph.length, 2);                          // 'No sales' dropped
  assert.equal(ph[0].productId, '1732471018497151084'); // re-ranked above the smaller one
  assert.equal(ph[0].gmv, 3304.28);
  assert.equal(ph[0].unitsSold, 165);
  assert.equal(ph[0].newVideos, 84);
});

test('empty lists leave the tables undefined so mergeAutofill keeps what the APC typed', () => {
  const d = run({ creators: [], products: null }).data;
  assert.equal(d.topCreators, undefined);
  assert.equal(d.productHighlights, undefined);
});

test('a missing optional call blanks only its own fields', () => {
  const op: any = run({ creatorsSummary: null, health: null }).data.overallPerformance;
  assert.equal(op.videosPosted, '');
  assert.equal(op.shopPerformanceScore, '');
  assert.equal(op.gmv, 3558.21);               // the headline survives
});

test('money is 2-decimal exact and counts are integers', () => {
  assert.equal(money(4812.860000000001), 4812.86);
  assert.equal(money(null), '');
  assert.equal(num('12.0'), 12);
  assert.equal(num(undefined), '');
});

test('checkpoint: opted-in and sample requests are Reacher\'s sample_requests; invites from the tier funnel', () => {
  const out = buildCheckpoint({ sample_requests: 1131 }, [{ week_start: '2026-10-11', total: { creators: 61108 } }], '2026-10-11');
  assert.equal(out.optedIn, 1131);
  assert.equal(out.sampleRequests, 1131);
  assert.equal(out.targetInvites, 61108);
  assert.deepEqual(out.approximate, ['targetInvites']);   // honest about the ~1% gap
});

test('checkpoint: picks the matching week and never sums several', () => {
  const weeks = [
    { week_start: '2026-10-04', total: { creators: 50419 } },
    { week_start: '2026-10-11', total: { creators: 61108 } },
  ];
  assert.equal(buildCheckpoint({ sample_requests: 1 }, weeks, '2026-10-11').targetInvites, 61108);
  // several weeks and none match: refuse to guess rather than pick one
  assert.equal(buildCheckpoint({ sample_requests: 1 }, weeks, '2026-10-25').targetInvites, null);
});

test('checkpoint: missing data is null (left manual), not 0', () => {
  const out = buildCheckpoint(null, null, '2026-10-11');
  assert.equal(out.targetInvites, null);
  assert.equal(out.optedIn, null);
  assert.equal(out.sampleRequests, null);
});
