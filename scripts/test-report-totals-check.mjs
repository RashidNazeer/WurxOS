// Run: node scripts/test-report-totals-check.mjs   (plain node, no network)
// The product table in a report must add up to the report's totals (GMV, orders,
// videos). These tests use figures from real approved reports.
import assert from 'node:assert/strict';

const C = await import(new URL('../src/lib/reportTotalsCheck.js', import.meta.url).href);

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log('  PASS  ' + name); pass++; }
  catch (e) { console.log('  FAIL  ' + name + '\n        ' + e.message); fail++; }
};
const CHECKS = (op) => [
  { key: 'gmv', label: 'GMV', total: op.gmv, productKey: 'gmv', money: true },
  { key: 'orders', label: 'Orders', total: op.orders, productKey: 'unitsSold' },
  { key: 'videos', label: 'Videos', total: op.videosPosted, productKey: 'newVideos' },
];
const states = (r) => Object.fromEntries(r.map((x) => [x.key, x.state]));
const run = (op, products) => C.productTotalsSummary({ checks: CHECKS(op), products });

t('Apothecary Oct 18 (real): everything adds up -> all three match', () => {
  const rows = run({ gmv: '360.78', orders: '24', videosPosted: '91' }, [
    { gmv: '300.10', unitsSold: '20', newVideos: '80' }, { gmv: '60.68', unitsSold: '4', newVideos: '11' },
  ]);
  assert.deepEqual(states(rows), { gmv: 'match', orders: 'match', videos: 'match' });
});
t('Dr Tobias Oct 18 (real): product GMV 4085.47 vs total 4083.25 is a mismatch of 2.22', () => {
  const rows = run({ gmv: '4083.25', orders: '223', videosPosted: '162' }, [
    { gmv: '3000.00', unitsSold: '150', newVideos: '112' }, { gmv: '1085.47', unitsSold: '73', newVideos: '50' },
  ]);
  const g = rows.find((r) => r.key === 'gmv');
  assert.equal(g.state, 'mismatch');
  assert.equal(g.diff.toFixed(2), '2.22');
  assert.match(g.text, /Product-wise GMV \(4085\.47\) does not match the total GMV \(4083\.25\)/);
  assert.match(g.text, /products are over by 2\.22/);
  assert.equal(rows.find((r) => r.key === 'orders').state, 'match');
  assert.equal(rows.find((r) => r.key === 'videos').state, 'match');
});
t('Bentgo Oct 18 (real): orders 34 vs products 35 is a mismatch', () => {
  const rows = run({ gmv: '100', orders: '34', videosPosted: '10' }, [{ gmv: '100', unitsSold: '35', newVideos: '10' }]);
  const o = rows.find((r) => r.key === 'orders');
  assert.equal(o.state, 'mismatch');
  assert.match(o.text, /Product-wise Orders \(35\) does not match the total Orders \(34\).*over by 1/);
});
t('Short products say "short by"', () => {
  const r = run({ gmv: '100', orders: '10', videosPosted: '10' }, [{ gmv: '90', unitsSold: '10', newVideos: '10' }]).find((x) => x.key === 'gmv');
  assert.match(r.text, /short by 10\.00/);
});
t('Money is compared to the cent; a one-cent gap is a mismatch, floating point noise is not', () => {
  const noisy = [{ gmv: '0.1' }, { gmv: '0.2' }];                       // 0.1 + 0.2 = 0.30000000000000004
  assert.equal(C.productTotalsSummary({ checks: [{ key: 'gmv', label: 'GMV', total: '0.30', productKey: 'gmv', money: true }], products: noisy })[0].state, 'match');
  assert.equal(C.productTotalsSummary({ checks: [{ key: 'gmv', label: 'GMV', total: '0.31', productKey: 'gmv', money: true }], products: noisy })[0].state, 'mismatch');
});
t('Formatted entries ("$1,234.50", " 1,000 ") are read as numbers', () => {
  const rows = C.productTotalsSummary({
    checks: [{ key: 'gmv', label: 'GMV', total: '$2,000.00', productKey: 'gmv', money: true }, { key: 'orders', label: 'Orders', total: ' 1,000 ', productKey: 'unitsSold' }],
    products: [{ gmv: '$1,234.50', unitsSold: '600' }, { gmv: '765.50', unitsSold: ' 400' }],
  });
  assert.deepEqual(states(rows), { gmv: 'match', orders: 'match' });
});
t('A blank total is "no-total", not a mismatch (the required-field check owns that)', () => {
  const rows = run({ gmv: '', orders: null, videosPosted: undefined }, [{ gmv: '10', unitsSold: '1', newVideos: '1' }]);
  assert.deepEqual(states(rows), { gmv: 'no-total', orders: 'no-total', videos: 'no-total' });
  assert.equal(C.productTotalsIssues({ checks: CHECKS({}), products: [{ gmv: '10' }] }).length, 0);
});
t('A total with an EMPTY product table is a mismatch (sum 0), so the breakdown cannot be skipped', () => {
  const rows = run({ gmv: '500', orders: '10', videosPosted: '5' }, []);
  assert.deepEqual(states(rows), { gmv: 'mismatch', orders: 'mismatch', videos: 'mismatch' });
});
t('Blank product cells count as zero', () => {
  const rows = run({ gmv: '10', orders: '2', videosPosted: '3' }, [{ gmv: '10', unitsSold: '', newVideos: undefined }, { gmv: '', unitsSold: '2', newVideos: '3' }]);
  assert.deepEqual(states(rows), { gmv: 'match', orders: 'match', videos: 'match' });
});
t('productTotalsMessages prefixes each issue for the form to route to its section', () => {
  const issues = C.productTotalsIssues({ checks: CHECKS({ gmv: '100', orders: '1', videosPosted: '1' }), products: [{ gmv: '90', unitsSold: '1', newVideos: '1' }] });
  const msgs = C.productTotalsMessages(issues, 'Product Highlights');
  assert.equal(msgs.length, 1);
  assert.ok(msgs[0].startsWith('Product Highlights: Product-wise GMV'));
  assert.match(msgs[0], /Others/);
});
t('A custom formatter is used in the text (currency symbol)', () => {
  const r = C.productTotalsSummary({
    checks: [{ key: 'gmv', label: 'GMV', total: '100', productKey: 'gmv', money: true }], products: [{ gmv: '90' }],
    fmt: (n, money) => (money ? `$${n.toFixed(2)}` : String(n)),
  })[0];
  assert.match(r.text, /\$90\.00.*\$100\.00.*\$10\.00/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
