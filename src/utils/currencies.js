/**
 * Currency definitions for reports. Each report row carries a `currency` code
 * in its `data` jsonb (default 'USD' for backward compat with reports created
 * before this feature).
 *
 * Add new currencies by appending to CURRENCIES — symbol/code/label all on one
 * line, no other code change required.
 *
 * Mirrors v1's src/utils/currencies.js verbatim so v1 and v2 stay 1:1.
 */

export const CURRENCIES = [
  { code: 'USD', symbol: '$',  label: 'US Dollar' },
  { code: 'GBP', symbol: '£',  label: 'British Pound' },
  { code: 'EUR', symbol: '€',  label: 'Euro' },
  { code: 'AUD', symbol: 'A$', label: 'Australian Dollar' },
  { code: 'CAD', symbol: 'C$', label: 'Canadian Dollar' },
  { code: 'JPY', symbol: '¥',  label: 'Japanese Yen' },
  { code: 'CNY', symbol: '¥',  label: 'Chinese Yuan' },
  { code: 'INR', symbol: '₹',  label: 'Indian Rupee' },
  { code: 'AED', symbol: 'د.إ', label: 'UAE Dirham' },
  { code: 'PKR', symbol: 'Rs',  label: 'Pakistani Rupee' },
];

const BY_CODE = Object.fromEntries(CURRENCIES.map((c) => [c.code, c]));
export const DEFAULT_CURRENCY = 'USD';

export function currencyInfo(code) {
  return BY_CODE[code] || BY_CODE[DEFAULT_CURRENCY];
}

export function currencySymbol(code) {
  return currencyInfo(code).symbol;
}

/** Format an amount as "<symbol>1,234.56". Used in detail views and stat cards. */
export function fmtMoney(amount, code = DEFAULT_CURRENCY) {
  const v = Number(amount) || 0;
  const sym = currencySymbol(code);
  return sym + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Compact: "<symbol>1.2k" / "<symbol>3.4M". Used in dense rows / charts. */
export function fmtMoneyShort(amount, code = DEFAULT_CURRENCY) {
  const n = Number(amount) || 0;
  const sym = currencySymbol(code);
  if (n >= 1_000_000) return sym + (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return sym + (n / 1_000).toFixed(1) + 'k';
  return sym + n.toFixed(0);
}
