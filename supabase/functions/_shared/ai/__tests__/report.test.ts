import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportExtractor, detectLayout } from '../extractors/report.ts';
import { chunkDocument } from '../chunker.ts';
import { chunkParamsFor } from '../config.ts';
import * as F from './fixtures/reports.ts';

const keys = (d: { sections: { key: string }[] }) => d.sections.map((s) => s.key);
const allText = (d: { header: string; sections: { text: string; title: string }[] }) =>
  [d.header, ...d.sections.flatMap((s) => [s.title, s.text])].join('\n');

test('layout detection covers the four real layouts and the fallback', () => {
  assert.equal(detectLayout(F.weeklySingle()), 'single');
  assert.equal(detectLayout(F.weeklyLegacy()), 'legacy');
  assert.equal(detectLayout(F.biweekly()), 'legacy');
  assert.equal(detectLayout(F.monthly()), 'monthly');
  assert.equal(detectLayout(F.generic()), 'generic');
  assert.equal(detectLayout({ ...F.monthly(), data: { foo: 'bar' } }), 'generic');
});

test('indexable only when approved (Owner decision, overrides D2)', () => {
  assert.ok(reportExtractor.indexable({ ...F.monthly(), status: 'approved' }, F.CTX));
  assert.equal(reportExtractor.skipReason!({ ...F.monthly(), status: 'approved' }, F.CTX), null);
  for (const s of ['submitted', 'verified', 'draft', 'rejected', '']) {
    assert.ok(!reportExtractor.indexable({ ...F.monthly(), status: s }, F.CTX), s);
    assert.match(reportExtractor.skipReason!({ ...F.monthly(), status: s }, F.CTX)!, /only approved reports are indexed/);
  }
  assert.match(reportExtractor.skipReason!({ ...F.monthly(), status: 'verified' }, F.CTX)!, /^status verified/);
});

test('header format, ACL and metadata', () => {
  const d = reportExtractor.toDocument(F.weeklySingle(), F.CTX);
  assert.equal(d.header, '[Weekly report · Acme Kitchen (client: Acme Holdings Ltd) · Week 12 · 2026-03-16 → 2026-03-22 · currency: USD]');
  assert.deepEqual(d.acl, { mode: 'report', authorId: F.AUTHOR_ID });
  assert.equal(d.brandId, F.BRAND_ID);
  assert.equal(d.periodStart, '2026-03-16');
  assert.equal(d.metadata.layout, 'single');
  assert.equal(d.metadata.status, 'approved');
  assert.equal(d.metadata.author_name, undefined);
  assert.equal(d.metadata.report_type, 'weekly');
  const bw = reportExtractor.toDocument(F.biweekly(), F.CTX);
  assert.ok(bw.header.startsWith('[Bi-weekly report · '));
  assert.ok(!bw.header.includes('status'));
  assert.equal(bw.metadata.status, 'submitted');
});

test('volatile fields stay out of every chunk: a status change leaves content and hashes identical', async () => {
  const run = async (status: string) =>
    (await chunkDocument(reportExtractor.toDocument({ ...F.weeklyLegacy(), status }, F.CTX), chunkParamsFor('report'))).chunks;
  const a = await run('submitted');
  const b = await run('approved');
  assert.ok(a.length > 1);
  assert.deepEqual(b.map((c) => [c.content, c.embed_text, c.content_hash]), a.map((c) => [c.content, c.embed_text, c.content_hash]));
});

test('weekly-single: one insights section, the six legacy fields ignored', () => {
  const d = reportExtractor.toDocument(F.weeklySingle(), F.CTX);
  assert.deepEqual(keys(d), [
    'summary', 'insights:all', 'written:recommendations', 'written:campaigns',
    'table:creators', 'table:videos', 'table:gmvmax', 'table:products',
    'custom', 'custom:cs_bbb_2', 'custom:cs_ccc_3',
  ]);
  const text = allText(d);
  assert.ok(!text.includes('LEGACY TEXT'));
  assert.ok(!text.includes('Offsite text hidden'));
  const insights = d.sections.find((s) => s.key === 'insights:all')!.text;
  assert.ok(insights.includes('• Top creator doubled output'));
  assert.ok(insights.includes('\nRisks\n'));
  assert.ok(insights.includes('low & may run out'));
});

test('empty values, placeholders and empty rows/sections are dropped', () => {
  const d = reportExtractor.toDocument(F.weeklySingle(), F.CTX);
  const summary = d.sections.find((s) => s.key === 'summary')!.text;
  assert.ok(!summary.includes('ROI'), 'N/A ROI dropped');
  assert.ok(!summary.includes('Videos posted (MTD)'), 'empty MTD dropped');
  assert.ok(!keys(d).includes('written:operational'), 'Not_Available_yet section dropped');
  assert.ok(!keys(d).includes('offsite'), 'all-empty offsite dropped');
  assert.ok(!keys(d).includes('table:gmvmax_mtd'), 'all-empty rows dropped');
  assert.equal(d.sections.find((s) => s.key === 'table:creators')!.text.split('\n').length, 1);
  const legacy = reportExtractor.toDocument(F.weeklyLegacy(), F.CTX);
  assert.ok(!keys(legacy).includes('insights:creators'), '"Null" insight dropped');
});

test('actionItems folded into recommendations', () => {
  const d = reportExtractor.toDocument(F.weeklySingle(), F.CTX);
  const rec = d.sections.find((s) => s.key === 'written:recommendations')!.text;
  assert.equal(rec, 'Increase sample approvals for mid-tier creators.\n\nAction items:\nSend 20 samples by Friday.');
});

test('excluded: rejectionNote, submittedBy*, highlights and the author name', async () => {
  for (const row of [F.weeklySingle(), F.generic()]) {
    const d = reportExtractor.toDocument(row, F.CTX);
    const { chunks } = await chunkDocument(d, chunkParamsFor('report'));
    const text = chunks.map((c) => c.content + c.embed_text).join('\n');
    for (const bad of ['INTERNAL REVIEWER NOTE', 'Submitter Person', '0000000000s1', '<mark>', 'Test Author']) {
      assert.ok(!text.includes(bad), `${bad} leaked into ${d.metadata.layout}`);
    }
  }
});

test('legacy: per-section insights, sections_enabled honoured, offsite window, stray keys kept', () => {
  const d = reportExtractor.toDocument(F.weeklyLegacy(), F.CTX);
  assert.deepEqual(keys(d), ['summary', 'insights:overall', 'insights:gmvmax', 'written:operational', 'offsite', 'other']);
  const text = allText(d);
  assert.ok(!text.includes('hidden_creator') && !text.includes('Disabled section text'), 'topVideos disabled');
  const offsite = d.sections.find((s) => s.key === 'offsite')!.text;
  assert.ok(offsite.includes('figures for 2026-03-01 → 2026-03-07'));
  assert.ok(offsite.includes('Amazon halo visible.'));
  const other = d.sections.find((s) => s.key === 'other')!.text;
  assert.ok(other.includes('LIVE GMV: 40.00') && other.includes('Stray weekly breakdown note'));
});

test('custom fields: short values, long text and tables; stale columns ignored', () => {
  const d = reportExtractor.toDocument(F.weeklySingle(), F.CTX);
  assert.equal(d.sections.find((s) => s.key === 'custom')!.text, '- Overall Performance › Total user count: 5120');
  assert.equal(d.sections.find((s) => s.key === 'custom:cs_ccc_3')!.text, '- Creator level: L3, Invites sent: 120');
  const off = F.weeklySingle();
  off.sections_enabled = { overallPerformance: false, cs_ccc_3: false };
  const d2 = reportExtractor.toDocument(off, F.CTX);
  assert.ok(!keys(d2).includes('custom') && !keys(d2).includes('custom:cs_ccc_3') && !keys(d2).includes('summary'));
});

test('monthly: summary, breakdown, disabled customers section, tables', () => {
  const d = reportExtractor.toDocument(F.monthly(), F.CTX);
  assert.deepEqual(keys(d), [
    'summary', 'insights:keywins', 'written:recommendations', 'written:campaigns',
    'monthly:breakdown', 'table:creators', 'table:videos', 'table:products',
  ]);
  const summary = d.sections.find((s) => s.key === 'summary')!;
  assert.equal(summary.kind, 'metrics');
  assert.ok(summary.text.startsWith('Total sales: GMV this month: 41000.00; All-time GMV: 250000.00.'));
  const breakdown = d.sections.find((s) => s.key === 'monthly:breakdown')!.text;
  assert.ok(breakdown.includes('Videos with 1M+ views: 1'));
  assert.ok(!allText(d).includes('SHOULD NOT APPEAR'), 'customers disabled via sections_enabled');
});

test('sectionsEnabled falls back to data.sectionsEnabled when the column is null', () => {
  const row = F.monthly();
  row.sections_enabled = null;
  (row.data as Record<string, unknown>).sectionsEnabled = { keyWinsInsights: false };
  const d = reportExtractor.toDocument(row, F.CTX);
  assert.ok(!keys(d).includes('insights:keywins'));
  assert.ok(allText(d).includes('SHOULD NOT APPEAR'), 'customers enabled again');
});

test('currency: brand, then report, then USD; always in the header', () => {
  const noCur = { ...F.biweekly() };
  assert.ok(reportExtractor.toDocument(noCur, F.CTX).header.endsWith('currency: USD]'));
  assert.equal(reportExtractor.toDocument(noCur, F.CTX).metadata.currency_source, 'default');
  assert.ok(reportExtractor.toDocument(F.weeklyLegacy(), F.CTX).header.endsWith('currency: GBP]'));
  assert.equal(reportExtractor.toDocument(F.weeklyLegacy(), F.CTX).metadata.currency_source, 'report', 'lower-case gbp snapshot');
  const brandGbp = { ...F.CTX, brand: { ...F.CTX.brand, currency: 'GBP' } };
  const d = reportExtractor.toDocument(noCur, brandGbp);
  assert.ok(d.header.endsWith('currency: GBP]'));
  assert.equal(d.metadata.currency_source, 'brand');
  // the brand wins over the report's own snapshot
  const brandEur = { ...F.CTX, brand: { ...F.CTX.brand, currency: 'eur' } };
  const e = reportExtractor.toDocument(F.weeklyLegacy(), brandEur);
  assert.ok(e.header.endsWith('currency: EUR]'));
  assert.equal(e.metadata.currency, 'EUR');
  assert.equal(e.metadata.currency_source, 'brand');
  // placeholder brand currency falls through to the report
  const brandNa = { ...F.CTX, brand: { ...F.CTX.brand, currency: 'N/A' } };
  assert.equal(reportExtractor.toDocument(F.weeklyLegacy(), brandNa).metadata.currency_source, 'report');
});

test('generic fallback flattens every non-empty field and flags the layout', () => {
  const d = reportExtractor.toDocument(F.generic(), F.CTX);
  assert.equal(d.metadata.layout, 'generic');
  assert.equal(d.metadata.legacy_id, 'fs-legacy-1');
  assert.deepEqual(keys(d), ['generic']);
  assert.equal(d.sections[0].text, 'Summary text: Imported from the old system.\nMetrics › Total GMV: 777.00\nRows › 1: Who: x_creator, Amount: 12.00');
});

test('every report chunk carries the header and stays under MAX', async () => {
  const P = chunkParamsFor('report');
  for (const row of [F.weeklySingle(), F.weeklyLegacy(), F.biweekly(), F.monthly(), F.generic()]) {
    const d = reportExtractor.toDocument(row, F.CTX);
    const { chunks } = await chunkDocument(d, P);
    assert.ok(chunks.length > 0);
    for (const c of chunks) {
      assert.ok(c.content.startsWith(d.header + '\n§ '));
      assert.ok(c.token_count <= P.max);
    }
  }
});
