import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retrievalConfig, RETRIEVAL_DEFAULTS } from '../retrieval/config.ts';
import { budgetFor, indexForSourceType, quotaFor } from '../retrieval/indexes.ts';
import {
  cleanBrandQuery, coverageFor, detectPeriods, expandSynonyms, pickBrand, pktToday, resolveBrands, resolvePeriod,
  resolveReportPeriod, weekStartFromReports, type ReportPeriodRow,
} from '../retrieval/resolve.ts';
import {
  defaultReportSections, diversify, joinWithNeighbours, pack, recencyFactor, searchEverything, searchIndex, titleOverlap,
  type Candidate,
} from '../retrieval/search.ts';
import { cachedEmbedder } from '../retrieval/rerank.ts';

// Tuesday 2026-09-29, 10:00 in Karachi (UTC+5).
const NOW = new Date('2026-09-29T05:00:00Z');
const range = (r: ReturnType<typeof resolvePeriod>) => (r.kind === 'range' ? [r.range.from, r.range.to] : r.kind);

// ── periods ─────────────────────────────────────────────────────────────────

test('pktToday: the Karachi date, not the UTC one, at both edges of midnight', () => {
  assert.equal(pktToday(new Date('2026-09-30T18:59:00Z')).toISOString().slice(0, 10), '2026-09-30');
  assert.equal(pktToday(new Date('2026-09-30T19:00:00Z')).toISOString().slice(0, 10), '2026-10-01');
  // 00:30 PKT on Oct 1 is still Sep 30 in UTC: "this month" is already October.
  assert.deepEqual(range(resolvePeriod('this month', new Date('2026-09-30T19:30:00Z'))), ['2026-10-01', '2026-10-31']);
  assert.deepEqual(range(resolvePeriod('yesterday', new Date('2026-09-30T19:30:00Z'))), ['2026-09-30', '2026-09-30']);
});

test('weeks run Sunday to Saturday by default; a brand can start on another day', () => {
  assert.deepEqual(range(resolvePeriod('last week', NOW)), ['2026-09-20', '2026-09-26']);
  const tw = resolvePeriod('this week', NOW);
  assert.deepEqual(range(tw), ['2026-09-27', '2026-10-03']);
  assert.equal(tw.kind === 'range' && tw.range.inProgress, true);
  assert.deepEqual(range(resolvePeriod('week before last', NOW)), ['2026-09-13', '2026-09-19']);
  assert.deepEqual(range(resolvePeriod('last week', NOW, { weekStartDow: 1 })), ['2026-09-21', '2026-09-27']);
  // On a Sunday the new week has begun.
  assert.deepEqual(range(resolvePeriod('last week', new Date('2026-09-27T05:00:00Z'))), ['2026-09-20', '2026-09-26']);
  // A bad week start falls back to Sunday.
  assert.deepEqual(range(resolvePeriod('last week', NOW, { weekStartDow: 9 })), ['2026-09-20', '2026-09-26']);
});

test('a bare month is the most recent one that has started', () => {
  assert.deepEqual(range(resolvePeriod('August', NOW)), ['2026-08-01', '2026-08-31']);
  assert.deepEqual(range(resolvePeriod('in june', NOW)), ['2026-06-01', '2026-06-30']);
  assert.deepEqual(range(resolvePeriod('October', NOW)), ['2025-10-01', '2025-10-31']);
  assert.deepEqual(range(resolvePeriod('September', NOW)), ['2026-09-01', '2026-09-30']);   // 29 of 30 days in
  assert.deepEqual(range(resolvePeriod('Aug 2025', NOW)), ['2025-08-01', '2025-08-31']);
  assert.deepEqual(range(resolvePeriod('2026-08', NOW)), ['2026-08-01', '2026-08-31']);
  assert.deepEqual(range(resolvePeriod('last month', new Date('2026-01-10T05:00:00Z'))), ['2025-12-01', '2025-12-31']);
  assert.deepEqual(range(resolvePeriod('February 2028', NOW)), ['2028-02-01', '2028-02-29']);
});

test('the current month early on is ambiguous: this one so far, or last year', () => {
  const r = resolvePeriod('September', new Date('2026-09-03T05:00:00Z'));
  assert.equal(r.kind, 'ambiguous');
  if (r.kind === 'ambiguous') {
    assert.deepEqual(r.options.map((o) => (o.kind === 'range' ? o.range.from : o.kind)), ['2026-09-01', '2025-09-01']);
  }
});

test('quarters, years and rolling windows', () => {
  assert.deepEqual(range(resolvePeriod('Q3', NOW)), ['2026-07-01', '2026-09-30']);
  assert.deepEqual(range(resolvePeriod('Q4', NOW)), ['2025-10-01', '2025-12-31']);
  assert.deepEqual(range(resolvePeriod('q2 2025', NOW)), ['2025-04-01', '2025-06-30']);
  assert.deepEqual(range(resolvePeriod('last quarter', new Date('2026-02-01T05:00:00Z'))), ['2025-10-01', '2025-12-31']);
  assert.deepEqual(range(resolvePeriod('this year', NOW)), ['2026-01-01', '2026-12-31']);
  assert.deepEqual(range(resolvePeriod('last 7 days', NOW)), ['2026-09-23', '2026-09-29']);
  assert.deepEqual(range(resolvePeriod('ytd', NOW)), ['2026-01-01', '2026-09-29']);
});

test('day ranges as report labels write them; the year is the most recent', () => {
  assert.deepEqual(range(resolvePeriod('Sep 13 - 19', NOW)), ['2026-09-13', '2026-09-19']);
  assert.deepEqual(range(resolvePeriod('the week of Sep 13-19, 2026'.replace('the week of ', ''), NOW)), ['2026-09-13', '2026-09-19']);
  assert.deepEqual(range(resolvePeriod('Aug 30 - Sep 5', NOW)), ['2026-08-30', '2026-09-05']);
  assert.deepEqual(range(resolvePeriod('Dec 28 - Jan 3', NOW)), ['2025-12-28', '2026-01-03']);
  assert.deepEqual(range(resolvePeriod('Nov 2', NOW)), ['2025-11-02', '2025-11-02']);
  assert.equal(resolvePeriod('Feb 30', NOW).kind, 'unknown');
  assert.equal(resolvePeriod('', NOW).kind, 'unknown');
  assert.equal(resolvePeriod('whenever', NOW).kind, 'unknown');
});

test('week numbers are brand-relative; a bare number is ambiguous', () => {
  assert.deepEqual(resolvePeriod('week 12', NOW), { kind: 'week_number', week: 12, label: 'Week 12' });
  assert.deepEqual(resolvePeriod('Wk34', NOW), { kind: 'week_number', week: 34, label: 'Week 34' });
  const r = resolvePeriod('12', NOW);
  assert.equal(r.kind, 'ambiguous');
  if (r.kind === 'ambiguous') assert.deepEqual(r.options.map((o) => o.kind), ['week_number', 'range']);
});

test('detectPeriods finds each phrase in order and leaves the verb "may" alone', () => {
  const p = (t: string) => detectPeriods(t, NOW).map((x) => x.phrase);
  assert.deepEqual(p("Compare Klassy Network's GMV in Week 24 with Week 23."), ['Week 24', 'Week 23']);
  assert.deepEqual(p('Did Obagi get more orders in August or July 2026?'), ['in August', 'July 2026']);
  assert.deepEqual(p("What was Obagi's GMV in the week of Sep 13-19, 2026?"), ['Sep 13-19, 2026']);
  assert.deepEqual(p('you may want to check'), []);
  assert.deepEqual(p('what happened in May'), ['in May']);
  assert.deepEqual(p('how are we doing this month?'), ['this month']);
});

// ── the brand's own calendar ────────────────────────────────────────────────

const rep = (brand: string, type: string, status: string, start: string, end: string, label = ''): ReportPeriodRow =>
  ({ report_id: `${brand}-${start}`, brand_id: brand, report_type: type, status, period_label: label, period_start: start, period_end: end });

test('weekStartFromReports: the mode of the brand\'s weekly starts, else Sunday', () => {
  const monday = [rep('b', 'weekly', 'approved', '2026-09-14', '2026-09-20'), rep('b', 'weekly', 'approved', '2026-09-07', '2026-09-13'),
    rep('b', 'monthly', 'approved', '2026-08-01', '2026-08-31')];
  assert.deepEqual(weekStartFromReports(monday), { dow: 1, source: 'brand' });
  assert.deepEqual(weekStartFromReports([rep('b', 'monthly', 'approved', '2026-08-01', '2026-08-31')]), { dow: 0, source: 'default' });
  assert.deepEqual(weekStartFromReports([]), { dow: 0, source: 'default' });
});

test('coverage: covered, awaiting approval, or not in yet with the latest approved one', () => {
  const rows = [
    rep('cut', 'weekly', 'approved', '2026-09-13', '2026-09-19', 'Week 24 (Sep 13 - 19)'),
    rep('cut', 'weekly', 'approved', '2026-09-06', '2026-09-12', 'Week 23 (Sep 6 - 12)'),
    rep('cut', 'weekly', 'verified', '2026-08-30', '2026-09-05', 'Week 22 (Aug 30 - Sep 5)'),
    rep('cut', 'monthly', 'approved', '2026-08-01', '2026-08-31', 'August 2026'),
  ];
  const [lastWeek] = coverageFor(rows, ['cut'], resolvePeriod('last week', NOW));
  assert.equal(lastWeek.status, 'not_in_yet');
  assert.equal(lastWeek.latestApproved?.period_label, 'Week 24 (Sep 13 - 19)');
  assert.equal(coverageFor(rows, ['cut'], resolvePeriod('week before last', NOW))[0].status, 'covered');
  const pend = coverageFor(rows, ['cut'], resolvePeriod('Aug 30 - Sep 5', NOW))[0];
  assert.equal(pend.status, 'awaiting_approval');
  assert.deepEqual(pend.otherApproved.map((r) => r.report_type), ['monthly']);   // August's monthly overlaps that week
  const sept = coverageFor([...rows, rep('cut', 'monthly', 'verified', '2026-09-01', '2026-09-30', 'September 2026')], ['cut'], resolvePeriod('September', NOW))[0];
  assert.equal(sept.status, 'awaiting_approval');
  assert.deepEqual(sept.otherApproved.map((r) => r.period_label), ['Week 24 (Sep 13 - 19)', 'Week 23 (Sep 6 - 12)']);
  assert.equal(sept.latestApproved?.period_label, 'August 2026');
  const aug = coverageFor(rows, ['cut'], resolvePeriod('August', NOW))[0];
  assert.equal(aug.status, 'covered');
  assert.deepEqual(aug.approved.map((r) => r.report_type), ['monthly']);   // a month is answered by the monthly report
  assert.equal(coverageFor(rows, ['cut'], resolvePeriod('week 23', NOW))[0].status, 'covered');
  assert.equal(coverageFor(rows, ['cut'], resolvePeriod('week 30', NOW))[0].status, 'not_in_yet');
  assert.equal(coverageFor(rows, ['other'], resolvePeriod('August', NOW))[0].latestApproved, null);
});

test('resolveReportPeriod: "last week" follows the brand\'s own week (Monday brand)', async () => {
  const calls: any[] = [];
  const rpc = async (fn: string, args: any) => {
    calls.push([fn, args]);
    return [rep('inno', 'weekly', 'approved', '2026-09-14', '2026-09-20', 'Week 3'), rep('inno', 'weekly', 'approved', '2026-09-07', '2026-09-13', 'Week 2')];
  };
  const r = await resolveReportPeriod(rpc, 'last week', { brandIds: ['inno'], asUser: 'u1', now: NOW });
  assert.deepEqual(r.weekStart, { dow: 1, source: 'brand' });
  assert.deepEqual(range(r.resolution), ['2026-09-21', '2026-09-27']);
  assert.equal(r.coverage[0].status, 'not_in_yet');
  assert.equal(calls[0][0], 'ai_report_periods');
  assert.equal(calls[0][1].p_as_user, 'u1');
  // No brand: no database call, org default week.
  const n = calls.length;
  const r2 = await resolveReportPeriod(rpc, 'last week', { now: NOW });
  assert.equal(calls.length, n);
  assert.deepEqual(range(r2.resolution), ['2026-09-20', '2026-09-26']);
});

// ── brands and synonyms ─────────────────────────────────────────────────────

test('brand queries: possessives and quotes stripped', () => {
  assert.equal(cleanBrandQuery("Bentgo's"), 'Bentgo');
  assert.equal(cleanBrandQuery('Cutler Nutritions\''), 'Cutler Nutritions');
  assert.equal(cleanBrandQuery('“Pure  Daily Care’s”'), 'Pure Daily Care');
});

test('pickBrand: sure only with a clear winner', () => {
  const m = (s: number, n = 'x') => ({ brand_id: n, brand_name: n, client_name: null, status: 'active', currency: 'USD', score: s });
  assert.equal(pickBrand([m(0.9, 'a'), m(0.4, 'b')]).best?.brand_id, 'a');
  assert.deepEqual(pickBrand([m(0.9, 'a'), m(0.8, 'b')]), { best: null, ambiguous: true });
  assert.deepEqual(pickBrand([m(0.45)]), { best: null, ambiguous: true });
  assert.deepEqual(pickBrand([]), { best: null, ambiguous: false });
});

test('resolveBrands passes the cleaned name and the relay user to the RPC', async () => {
  let seen: any;
  const rpc = async (_fn: string, args: any) => { seen = args; return [{ brand_id: 'c', brand_name: 'Cutler Nutritions', client_name: 'B', status: 'active', currency: 'USD', score: '0.9' }]; };
  const r = await resolveBrands(rpc, "Cutler Nutrition's", { asUser: 'boss' });
  assert.deepEqual(seen, { p_name: 'Cutler Nutrition', p_as_user: 'boss' });
  assert.equal(r.best?.brand_name, 'Cutler Nutritions');
  assert.equal(typeof r.matches[0].score, 'number');
});

test('synonyms feed the keyword arm with terms the query lacks', () => {
  assert.deepEqual(expandSynonyms('how do I take time off'), ['leave']);
  assert.deepEqual(expandSynonyms('can an influencer get banned'), ['creator', 'violation']);
  assert.deepEqual(expandSynonyms('what is our leave policy'), []);
  assert.deepEqual(expandSynonyms('LDR limit'), ['late dispatch rate']);
});

// ── pure search stages ──────────────────────────────────────────────────────

const cand = (doc: string, idx: number, score: number, extra: Partial<Candidate> = {}): Candidate => ({
  chunk_id: `${doc}#${idx}`, document_id: doc, chunk_index: idx, source_type: 'kb_article', source_id: doc, title: `Doc ${doc}`,
  url: null, section: 'sop', content: `[KB · ${doc}]\n${'x'.repeat(396)}`, brand_id: null, period_start: null, period_end: null,
  metadata: {}, score, adj: score, ...extra,
});

test('diversify keeps at most N chunks per document, in order', () => {
  const out = diversify([cand('a', 0, 1), cand('a', 1, 0.9), cand('a', 2, 0.8), cand('b', 0, 0.7)], 2);
  assert.deepEqual(out.map((c) => c.chunk_id), ['a#0', 'a#1', 'b#0']);
});

test('recency: half weight at one half-life, none for the future', () => {
  const now = new Date('2026-09-29T00:00:00Z');
  assert.equal(recencyFactor('2026-09-29', now, 120), 1);
  assert.ok(Math.abs(recencyFactor('2026-06-01', now, 120) - 0.5) < 1e-9);
  assert.ok(Math.abs(recencyFactor('2026-02-01', now, 120) - 0.25) < 1e-9);
  assert.equal(recencyFactor('2026-12-01', now, 120), 1);
  assert.equal(recencyFactor(null, now, 120), 1);
});

test('title overlap uses content words and light stemming', () => {
  assert.equal(titleOverlap(['approving', 'sample', 'requests'], 'How to approve sample requests'), 1);
  assert.equal(titleOverlap(['violation', 'appeal'], 'Flagged Products'), 0);
  assert.equal(titleOverlap([], 'x'), 0);
});

test('report sections: narrative by default, a table only when asked for', () => {
  const n = RETRIEVAL_DEFAULTS.REPORT_NARRATIVE_SECTIONS;
  assert.deepEqual(defaultReportSections('why did GMV drop', n), n);
  assert.ok(defaultReportSections('who were the top creators', n).includes('table:creators'));
  assert.ok(defaultReportSections('which brands had strong GMV Max results', n).includes('table:gmvmax'));
  assert.ok(!defaultReportSections('creator outreach recommendations', n).includes('table:creators'));
});

test('pack: budget respected, first result always kept, neighbours only from what is left', () => {
  // Each candidate is ~100 tokens.
  const top = [cand('a', 1, 3), cand('b', 0, 2), cand('c', 0, 1)];
  const nb = new Map([['a#1', [{ chunk_index: 0, section: 'sop', content: `[KB · a]\n${'p'.repeat(396)}` }, { chunk_index: 2, section: 'sop', content: `[KB · a]\n${'n'.repeat(396)}` }]]]);
  const full = pack('company', top, nb, 1000, 3);
  assert.deepEqual(full.map((p) => p.cite), ['S1', 'S2', 'S3']);
  assert.deepEqual(full[0].chunk_indexes, [0, 1, 2]);
  assert.equal((full[0].text.match(/\[KB · a\]/g) ?? []).length, 1);   // one header
  const tight = pack('company', top, nb, 350, 3, 5);
  assert.deepEqual(tight.map((p) => p.cite), ['S5', 'S6', 'S7']);
  assert.equal(tight[0].chunk_indexes.length, 1);                          // no room for neighbours
  assert.ok(tight.reduce((a, p) => a + p.tokens, 0) <= 350);
  const one = pack('company', top, nb, 40, 3);
  assert.equal(one.length, 1);
  assert.ok(one[0].tokens <= 40);
});

test('pack carries the citation metadata of a report', () => {
  const c = cand('r', 0, 1, {
    source_type: 'report', period_start: '2026-09-13', period_end: '2026-09-19', brand_id: 'b1',
    metadata: { brand_name: 'Bentgo', period_label: 'Week 24 (Sep 13 - 19)', report_type: 'weekly', status: 'approved', currency: 'USD' },
  });
  const [p] = pack('reports', [c], new Map(), 2500, 0);
  assert.deepEqual([p.brand, p.period?.label, p.report_type, p.status, p.currency], ['Bentgo', 'Week 24 (Sep 13 - 19)', 'weekly', 'approved', 'USD']);
});

test('joinWithNeighbours orders by chunk index', () => {
  const j = joinWithNeighbours({ chunk_index: 1, content: '[H]\nmid' }, [{ chunk_index: 2, section: null, content: '[H]\nend' }, { chunk_index: 0, section: null, content: '[H]\nstart' }]);
  assert.equal(j.text, '[H]\nstart\n…\nmid\n…\nend');
  assert.deepEqual(j.indexes, [0, 1, 2]);
});

// ── searchIndex / searchEverything over a fake store ────────────────────────

function fakeStore() {
  const rows: any[] = [];
  const add = (type: string, doc: string, n: number, score: number, meta: any = {}, period?: [string, string]) => {
    for (let i = 0; i < n; i++) {
      rows.push({
        chunk_id: `${doc}#${i}`, document_id: doc, chunk_index: i, source_type: type, source_id: doc, title: `${type} ${doc}`,
        url: null, section: type === 'report' ? 'summary' : 'body', content: `[${doc}]\n${'w'.repeat(200)}`, brand_id: null,
        period_start: period?.[0] ?? null, period_end: period?.[1] ?? null, metadata: meta, score: score - i * 0.001,
      });
    }
  };
  for (let d = 0; d < 12; d++) add('tts_article', `t${d}`, 3, 0.05 - d * 0.001);
  for (let d = 0; d < 6; d++) add('kb_article', `k${d}`, 2, 0.02 - d * 0.001);
  add('report', 'old', 2, 0.03, { report_type: 'weekly', period_label: 'Week 1' }, ['2025-09-01', '2025-09-07']);
  add('report', 'new', 2, 0.02, { report_type: 'weekly', period_label: 'Week 12' }, ['2026-09-13', '2026-09-19']);
  add('incentive', 'i0', 1, 0.01, { month: '2026-09' });
  const calls: any[] = [];
  const rpc = async (fn: string, args: any) => {
    calls.push([fn, args]);
    if (fn === 'ai_get_chunks') return rows.filter((r) => r.document_id === args.p_document_id && r.chunk_index >= args.p_from && r.chunk_index <= args.p_to);
    let out = rows.filter((r) => args.p_source_types.includes(r.source_type));
    if (args.p_period_from) out = out.filter((r) => r.period_end >= args.p_period_from);
    if (args.p_period_to) out = out.filter((r) => r.period_start <= args.p_period_to);
    return out.sort((a, b) => b.score - a.score).slice(0, args.p_match_count).map((r) => ({ ...r }));
  };
  return { rpc, calls };
}
const embed = async () => [0.1, 0.2];
const cfgNoBoost = retrievalConfig({ TITLE_BOOST: 0 }).config;

test('searchIndex: its own corpus only, ≤2 per document, sections and pool passed down', async () => {
  const { rpc, calls } = fakeStore();
  const r = await searchIndex('company', 'approve samples', {}, { rpc, embed, asUser: 'boss', config: cfgNoBoost, now: NOW });
  assert.ok(r.results.every((x) => x.source_type === 'kb_article'));
  assert.equal(r.results.length, 8);
  const perDoc = new Map<string, number>();
  for (const x of r.results) perDoc.set(x.document_id, (perDoc.get(x.document_id) ?? 0) + 1);
  assert.ok([...perDoc.values()].every((n) => n <= 2));
  const [, args] = calls.find(([fn]) => fn === 'ai_search');
  assert.deepEqual(args.p_source_types, ['kb_article', 'ai_doc', 'app_guide']);
  assert.equal(args.p_match_count, 40);
  assert.equal(args.p_as_user, 'boss');
  assert.equal(args.p_sections, undefined);
  assert.equal(calls.filter(([fn]) => fn === 'ai_get_chunks').length, 3);   // neighbours for the top 3
});

test('searchIndex (reports): narrative sections by default, recency decides without a period, titles ignored', async () => {
  const { rpc, calls } = fakeStore();
  // A big title boost would favour "report old" for the query "old": report titles are generated, so it must not apply.
  const r = await searchIndex('reports', 'why did GMV drop old', {}, { rpc, embed, config: retrievalConfig({ TITLE_BOOST: 5 }).config, now: NOW });
  assert.deepEqual(calls[0][1].p_sections, ['summary', 'insights', 'written', 'offsite']);
  assert.equal(r.results[0].document_id, 'new');   // 'old' has the higher RRF but is a year older
  const all = await searchIndex('reports', 'x', { sections: 'all' }, { rpc, embed, config: cfgNoBoost, now: NOW });
  assert.equal(all.sections, null);
});

test('searchIndex (reports): an empty period is relaxed and said so; week numbers filter labels', async () => {
  const { rpc } = fakeStore();
  const r = await searchIndex('reports', 'GMV', { periodFrom: '2026-09-20', periodTo: '2026-09-26' }, { rpc, embed, config: cfgNoBoost, now: NOW });
  assert.ok(r.results.length > 0);
  assert.match(r.notes.join(' '), /no approved report text/);
  const w = await searchIndex('reports', 'GMV', { weekNumber: 12 }, { rpc, embed, config: cfgNoBoost, now: NOW });
  assert.deepEqual([...new Set(w.results.map((x) => x.document_id))], ['new']);
});

test('searchIndex (reports): several week numbers; one chunk per report across brands, two within a brand', async () => {
  const { rpc, calls } = fakeStore();
  const w = await searchIndex('reports', 'compare', { weekNumber: [12, 1] }, { rpc, embed, config: cfgNoBoost, now: NOW });
  assert.deepEqual(new Set(w.results.map((x) => x.document_id)), new Set(['new', 'old']));
  assert.match(calls[0][1].p_query_text, /week 12 week 1$/);
  assert.equal(w.results.length, 2);                                   // no brand filter: 1 per report
  const b = await searchIndex('reports', 'compare', { brandIds: ['b'], weekNumber: 12 }, { rpc, embed, config: cfgNoBoost, now: NOW });
  assert.equal(b.results.length, 2);                                   // brand filter: 2 chunks of the one report
  assert.equal(b.ranked.length, 2);
});

test('searchIndex (reports): one brand, no period → its latest reports come first', async () => {
  const { rpc, calls } = fakeStore();
  const config = retrievalConfig({ TITLE_BOOST: 0, RECENCY_HALF_LIFE_DAYS: 100000 }).config;   // recency off: only the pass acts
  const r = await searchIndex('reports', 'how are we doing', { brandIds: ['b'] }, { rpc, embed, config, now: NOW });
  assert.equal(r.results[0].document_id, 'new');
  const recent = calls.filter(([fn, a]) => fn === 'ai_search' && a.p_period_from);
  assert.deepEqual(recent.map(([, a]) => a.p_period_from), ['2026-09-08']);
  const off = await searchIndex('reports', 'how are we doing', { brandIds: ['b'] },
    { rpc, embed, config: { ...config, RECENT_PASS_DAYS: 0 }, now: NOW });
  assert.equal(off.results[0].document_id, 'old');
});

test('searchIndex: no embedding → keyword only, noted', async () => {
  const { rpc, calls } = fakeStore();
  const r = await searchIndex('tiktok', 'late dispatch', {}, { rpc, embed: async () => { throw new Error('down'); }, config: cfgNoBoost, now: NOW });
  assert.equal(calls[0][1].p_query_embedding, null);
  assert.match(r.notes[0], /keyword search only/);
});

test('searchEverything: fixed quotas per group, one chunk per document, cites run on', async () => {
  const { rpc } = fakeStore();
  const f = await searchEverything('samples', { rpc, embed, config: cfgNoBoost, now: NOW });
  assert.deepEqual(f.groups.map((g) => [g.index, g.results.length]), [['company', 4], ['reports', 2], ['tiktok', 3], ['incentives', 1]]);
  assert.deepEqual(f.groups.flatMap((g) => g.results.map((r) => r.cite)), ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10']);
  for (const g of f.groups) assert.equal(new Set(g.results.map((r) => r.document_id)).size, g.results.length);
  // TikTok outscores everything in the fake store, yet takes only its quota.
  assert.equal(f.groups.find((g) => g.index === 'tiktok')!.results.length, 3);
});

test('searchEverything: an empty group is dropped (e.g. incentives the caller cannot read)', async () => {
  const { rpc } = fakeStore();
  const noInc = async (fn: string, args: any) => (args.p_source_types?.includes('incentive') ? [] : rpc(fn, args));
  const f = await searchEverything('samples', { rpc: noInc, embed, config: cfgNoBoost, now: NOW });
  assert.deepEqual(f.groups.map((g) => g.index), ['company', 'reports', 'tiktok']);
});

test('rerank reorders the head when enabled, and a failure keeps the fused order', async () => {
  const { rpc } = fakeStore();
  const config = retrievalConfig({ TITLE_BOOST: 0, RERANK_ENABLED: true, RERANK_INDEXES: ['company'] }).config;
  // Not listed → not reranked.
  const off = await searchIndex('company', 'x', {}, { rpc, embed, config: { ...config, RERANK_INDEXES: ['reports'] }, now: NOW,
    rerank: async () => { throw new Error('must not run'); } });
  assert.equal(off.notes.length, 0);
  const rerank = async (_q: string, items: any[]) => items.map((it) => (it.id === 'k5#0' ? 10 : 0));
  const r = await searchIndex('company', 'x', {}, { rpc, embed, config, now: NOW, rerank });
  assert.equal(r.results[0].document_id, 'k5');
  const bad = await searchIndex('company', 'x', {}, { rpc, embed, config, now: NOW, rerank: async () => { throw new Error('x'); } });
  assert.equal(bad.results[0].document_id, 'k0');
  assert.match(bad.notes.join(' '), /rerank failed/);
});

// ── config, indexes, cache ──────────────────────────────────────────────────

test('config overrides: known keys validated, agent keys ignored silently', () => {
  const { config, ignored } = retrievalConfig({ TOP_K: 5, QUOTA_TIKTOK: 0, RETRIEVAL_POOL: -1, SYNONYMS: 'yes', MAX_ROUNDS: 3,
    REPORT_NARRATIVE_SECTIONS: ['summary'] });
  assert.equal(config.TOP_K, 5);
  assert.equal(config.QUOTA_TIKTOK, 0);
  assert.equal(config.RETRIEVAL_POOL, 40);
  assert.deepEqual(config.REPORT_NARRATIVE_SECTIONS, ['summary']);
  assert.deepEqual(ignored.sort(), ['RETRIEVAL_POOL', 'SYNONYMS']);
  assert.deepEqual(RETRIEVAL_DEFAULTS.REPORT_NARRATIVE_SECTIONS, ['summary', 'insights', 'written', 'offsite']);   // defaults untouched
});

test('indexes: source types, budgets and quotas', () => {
  const cfg = retrievalConfig().config;
  assert.equal(indexForSourceType('ai_doc'), 'company');
  assert.equal(indexForSourceType('tts_article'), 'tiktok');
  assert.equal(indexForSourceType('salary'), null);
  assert.deepEqual([budgetFor('company', cfg), budgetFor('reports', cfg), budgetFor('tiktok', cfg)], [2500, 3500, 3500]);
  assert.deepEqual([quotaFor('company', cfg), quotaFor('reports', cfg), quotaFor('tiktok', cfg), quotaFor('incentives', cfg)], [4, 3, 3, 1]);
});

test('cachedEmbedder: one call per text within the TTL, retried after a failure', async () => {
  let n = 0, t = 0, fail = true;
  const e = cachedEmbedder(async () => { n++; if (fail) { fail = false; throw new Error('x'); } return [n]; }, 1000, 10, () => t);
  await assert.rejects(e('a'));
  assert.deepEqual(await e('a'), [2]);
  assert.deepEqual(await e(' a '), [2]);
  t = 2000;
  assert.deepEqual(await e('a'), [3]);
});
