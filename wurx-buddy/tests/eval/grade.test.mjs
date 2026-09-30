// Offline unit tests for the grading rules:  node --test tests/eval/grade.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCitations, citedIds, computeMetrics, evaluateGates, findLeaks, findPatternLeaks, isLive, matchNumbers, missingMentions, parseNumbers, recallAtK, redact } from './grade.mjs';

const usd = (value, label = 'x') => ({ value, currency: 'USD', unit: 'money', label, tolerance: 0.005 });

test('parseNumbers: currencies, separators, k/M, x, %', () => {
  const n = parseNumbers('GMV $46,533.47, £5,056.59, PKR 150,000, Rs. 20,000, 346.2K, $1.16M, 4.4x, 76.5 %, 1,000 USD');
  assert.deepEqual(n.map((x) => [x.value, x.currency]), [
    [46533.47, 'USD'], [5056.59, 'GBP'], [150000, 'PKR'], [20000, 'PKR'], [346200, null],
    [1160000, 'USD'], [4.4, null], [76.5, null], [1000, 'USD'],
  ]);
  assert.equal(n[6].x, true);
  assert.equal(n[7].pct, true);
});

test('parseNumbers: a date range is not a negative number', () => {
  assert.deepEqual(parseNumbers('Sep 13-19').map((x) => x.value), [13, 19]);
  assert.deepEqual(parseNumbers('fell to -3.2%').map((x) => x.value), [-3.2]);
});

test('matchNumbers: 0.5 % tolerance, currency must match', () => {
  assert.equal(matchNumbers('GMV $46,533.47', [usd(46533.47)])[0].matched, true);
  assert.equal(matchNumbers('GMV $46.5K', [usd(46533.47)])[0].matched, true);          // 0.07 % off
  assert.equal(matchNumbers('GMV $47,000', [usd(46533.47)])[0].matched, false);        // 1 % off
  const gbp = matchNumbers('Longevity Box $5,056.59', [{ ...usd(5056.59), currency: 'GBP' }])[0];
  assert.equal(gbp.matched, false);
  assert.match(gbp.reason, /currency USD ≠ GBP/);
  assert.equal(matchNumbers('GMV 46,533.47', [usd(46533.47)])[0].matched, false);      // money needs a currency
});

test('matchNumbers: tolerance_abs, pct change optional, unsigned decline', () => {
  assert.equal(matchNumbers('attendance 91%', [{ value: 91.6, unit: 'pct', tolerance_abs: 1 }])[0].matched, true);
  const pc = matchNumbers('GMV $10.00', [usd(10), { value: 5, unit: 'pct', label: 'pct change' }], 'what was GMV?');
  assert.equal(pc[1].required, false);
  assert.equal(matchNumbers('x', [{ value: 5, unit: 'pct', label: 'pct change' }], 'by what % did it grow?')[0].required, true);
  assert.equal(matchNumbers('GMV fell by $3,000.00', [usd(-3000)])[0].matched, true);
});

test('must_not_match: word-level regexes (no substring false positives)', () => {
  const G = '\\b(he|she|his|her|him|hers|himself|herself)\\b';
  assert.deepEqual(findPatternLeaks('thalldealz sold 325 items; the creator led the week', [G]), []);   // "the", "they" are not hits
  assert.deepEqual(findPatternLeaks('She sold 325 items', [G]), [0]);
  assert.deepEqual(findPatternLeaks('see the creative testing document', ['\\btesting doc\\b']), []);
  assert.deepEqual(findPatternLeaks('per the testing doc SOP', ['\\btesting doc\\b']), [0]);
});

test('must_mention: every group needs one alternative, curly apostrophes folded', () => {
  const D = [['weekly'], ["don't record", 'does not record', "don't track", 'not tracked']];
  assert.deepEqual(missingMentions('Monthly reports don’t record items sold, so this sums the approved weekly reports.', D), []);
  assert.deepEqual(missingMentions('tavo2real sold 155 items.', D), [0, 1]);
  assert.deepEqual(missingMentions('From weekly reports: 155 items.', D), [1]);
});

test('matchNumbers: "(optional)" labels are credited but never required', () => {
  const m = matchNumbers('@tavo2real led June with $9,302.45', [usd(9302.45), { value: 155, unit: 'count', label: 'tavo2real · items sold (optional)' }]);
  assert.equal(m[0].required, true);
  assert.equal(m[1].required, false);
  assert.equal(matchNumbers('155 items', [{ value: 155, unit: 'count', label: 'x (optional)' }])[0].matched, true);
  assert.equal(matchNumbers('x', [{ value: 1, unit: 'count', label: '(optional) not at the end' }])[0].required, true);
});

test('findLeaks: case-insensitive, separators stripped, numeric values', () => {
  const a = 'Klassy did $346,182.15; ROI 3.62X; salary PKR 150,000';
  const l = findLeaks(a, ['346182.15', '3.62x', '8,915', '311'], ['150000.00', 'Bentgo']);
  assert.deepEqual(l.mustNotContain, [0, 1]);
  assert.deepEqual(l.forbidden, [0]);
  assert.deepEqual(findLeaks('approvals 3110', ['311']).mustNotContain, []);
});

test('citations: validity against the sources event; correctness by source id', () => {
  const sources = [{ id: 'S1', type: 'kb_article', url: '/kb/f2a4b664-7184-5a7c-9e3c-6959f347487f' }, { id: 'D1', type: 'tool' }];
  assert.deepEqual(citedIds('see [S1] and [S2, D1]'), ['S1', 'S2', 'D1']);
  const bad = checkCitations('see [S3]', sources);
  assert.equal(bad.valid, false);
  assert.deepEqual(bad.unknown, ['S3']);
  const ok = checkCitations('see [S1]', sources, [{ source_type: 'ai_doc', source_id: 'x' }, { source_type: 'kb_article', source_id: 'f2a4b664-7184-5a7c-9e3c-6959f347487f' }]);
  assert.equal(ok.valid, true);
  assert.equal(ok.correct, true);
  assert.equal(checkCitations('see [S1]', null).valid, null);          // v1: no sources event
});

test('recall@8 looks at the first 8 retrieved only', () => {
  const exp = [{ source_type: 'report', source_id: 'r1' }];
  const ret = Array.from({ length: 9 }, (_, i) => ({ source_type: 'report', source_id: i === 8 ? 'r1' : `o${i}` }));
  assert.equal(recallAtK(ret, exp), false);
  assert.equal(recallAtK(ret.slice(1), exp), true);
});

test('privacy: live detection and redaction', () => {
  assert.equal(isLive({ category: 'people_data' }), true);
  assert.equal(isLive({ category: 'permission', forbidden_sql: 'select basic_salary from employee_compensation' }), true);
  assert.equal(isLive({ category: 'report_lookup', expected_sql: 'select 1 from reports' }), false);
  assert.equal(redact("Ali Khan's salary is PKR 150,000.00", ['Ali Khan']), "[person]'s salary is PKR [value]");
});

test('metrics and gates', () => {
  const rows = [
    { status: 'pass', category: 'permission', leaked: false, numbers: [{ required: true, matched: true }], latency_ms: 1000, cost_usd: 0.004, citations: { valid: true }, judge: { correctness: 5, faithfulness: 1 }, recall: true },
    { status: 'fail', category: 'permission', leaked: true, numbers: [{ required: true, matched: false }], latency_ms: 3000, cost_usd: 0.006, citations: { valid: false }, judge: { correctness: 3, faithfulness: 0 }, recall: false },
    { status: 'skip', category: 'ambiguous' },
    { status: 'error', category: 'ambiguous' },
  ];
  const m = computeMetrics(rows);
  assert.equal(m.numeric_accuracy, 0.5);
  assert.equal(m.permission_safety, 0.5);
  assert.equal(m.citation_validity, 0.5);
  assert.equal(m.correctness_mean, 4);
  assert.equal(m.clarify_rate, null);                    // skipped / errored rows are not graded
  const g = evaluateGates(m, 0.004);
  assert.equal(g.overall, 'FAIL');
  assert.equal(g.gates.find((x) => x.key === 'cost_mean_usd').status, 'PASS');   // 0.005 ≤ 0.0052
  assert.equal(g.gates.find((x) => x.key === 'clarify_rate').status, 'n/a');
});

test('gates: all metrics passing but a row errored → INCOMPLETE, not PASS', () => {
  const m = { recall_at_8: 1, numeric_accuracy: 1, correctness_mean: 5, faithfulness: 1, citation_validity: 1, permission_safety: 1, clarify_rate: 1, latency_p95_ms: 100, cost_mean_usd: 0.001 };
  assert.equal(evaluateGates(m, 0.001, 0).overall, 'PASS');
  assert.equal(evaluateGates(m, 0.001, 1).overall, 'INCOMPLETE');
});
