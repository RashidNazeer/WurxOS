// ============================================================
// Product table vs report totals.
//
// A report states a total (shop GMV, orders, videos posted) AND a product-wise
// breakdown of the same thing. The two must add up: a client who adds the
// product rows and gets a different number than the headline loses trust in
// both. The report forms use this to show the summed product figure next to the
// total as the APC types, and to block Submit while they disagree.
//
// Pure: no React, no supabase. Money is compared to the cent, counts exactly.
// A total the APC has not filled in yet is reported as "not entered" and is NOT
// a mismatch: "required field" already covers that blank.
// ============================================================

const toNum = (v) => {
  if (v == null) return null;
  const s = String(v).replace(/[$£€₨,\s]/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const sumOf = (rows, key) => (rows || []).reduce((a, r) => a + (toNum(r?.[key]) || 0), 0);
const cents = (n) => Math.round(n * 100);

const defaultFmt = (n, money) => (money ? n.toFixed(2) : String(Math.round(n)));

/**
 * `checks`  [{ key, label, total, productKey, money? }]
 *   key         stable id ('gmv' | 'orders' | 'videos')
 *   label       what the APC calls it, e.g. 'GMV'
 *   total       the report's total (string or number)
 *   productKey  the field summed across the product rows
 *   money       true to compare to the cent
 * `products` the product rows
 * `fmt`      (n, money) => string, so each form prints in its own currency
 *
 * Returns one entry per check:
 *   { key, label, money, total (number|null), productSum, diff, state, text }
 *   state: 'match' | 'mismatch' | 'no-total'
 */
export function productTotalsSummary({ checks, products, fmt }) {
  const show = fmt || defaultFmt;
  return (checks || []).map((c) => {
    const total = toNum(c.total);
    const productSum = sumOf(products, c.productKey);
    const base = { key: c.key, label: c.label, money: !!c.money, total, productSum, diff: 0 };
    if (total == null) return { ...base, state: 'no-total', text: '' };
    const same = c.money ? cents(productSum) === cents(total) : Math.round(productSum) === Math.round(total);
    if (same) return { ...base, state: 'match', text: '' };
    const diff = productSum - total;
    return {
      ...base, diff, state: 'mismatch',
      text: `Product-wise ${c.label} (${show(productSum, c.money)}) does not match the total ${c.label} (${show(total, c.money)}) — `
        + `${diff > 0 ? 'products are over by' : 'products are short by'} ${show(Math.abs(diff), c.money)}.`,
    };
  });
}

/** Only the disagreements. */
export const productTotalsIssues = (args) => productTotalsSummary(args).filter((r) => r.state === 'mismatch');

/** The submit-blocking messages, prefixed so each form routes them to its product section. */
export function productTotalsMessages(issues, sectionName) {
  return issues.map((i) => `${sectionName}: ${i.text} Fix the product rows (add an “Others” row for the remainder) so they add up.`);
}
