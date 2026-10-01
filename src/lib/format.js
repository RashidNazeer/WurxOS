// Shared number / money formatting. Money is always 2-decimal exact
// (CLAUDE.md): 150000 → 'PKR 150,000.00', 859.95 → '$859.95'.
// Empty, null or non-numeric input renders as an em dash.

const DASH = '—';

function toNumber(n) {
  if (n === null || n === undefined || n === '') return null;
  const v = typeof n === 'number' ? n : Number(String(n).replace(/,/g, ''));
  return Number.isFinite(v) ? v : null;
}

const groupFmt = (decimals) => new Intl.NumberFormat('en-US', {
  minimumFractionDigits: decimals,
  maximumFractionDigits: decimals,
});
const money2 = groupFmt(2);

export function formatNumber(n, { decimals = 0 } = {}) {
  const v = toNumber(n);
  return v === null ? DASH : groupFmt(decimals).format(v);
}

export function formatPKR(n) {
  const v = toNumber(n);
  if (v === null) return DASH;
  const sign = v < 0 ? '-' : '';
  return `${sign}PKR ${money2.format(Math.abs(v))}`;
}

// PKR keeps the 'PKR 1,234.00' form; anything else uses the currency's
// own symbol via Intl ('$859.95').
export function formatMoney(n, currency = 'USD') {
  if (String(currency).toUpperCase() === 'PKR') return formatPKR(n);
  const v = toNumber(n);
  if (v === null) return DASH;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(v);
  } catch {
    // Unknown currency code: keep the code as a prefix rather than throw.
    return `${currency} ${money2.format(v)}`;
  }
}

// formatPercent(12.345) → '12.3%'; formatPercent(0.1234, { ratio: true }) → '12.3%'.
export function formatPercent(n, { decimals = 1, ratio = false, signed = false } = {}) {
  const v = toNumber(n);
  if (v === null) return DASH;
  const pct = ratio ? v * 100 : v;
  const body = groupFmt(decimals).format(pct);
  return `${signed && pct > 0 ? '+' : ''}${body}%`;
}
