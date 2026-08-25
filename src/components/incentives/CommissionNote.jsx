import { currencySymbol } from '../../utils/currencies';
import { getMonthLabel } from '../../lib/incentivesApi';

// The one-line explanation under a Commission Based Tier item (mig 333).
//
// This exists because the number on a commission line is the only money in the
// incentives module that nobody typed: it comes from the brand's GMV, a goal
// somebody set in Brand Analytics, and an exchange rate set somewhere else
// again. When it reads zero — which is the normal state for most of a month —
// the person looking at it deserves to know WHICH of those three is the reason,
// rather than assuming the feature is broken.
//
// `_commissionInfo` is attached by applyCommissionAutofill at read time and
// never persisted; when it is absent the overlay has not run (a paid row reads
// its frozen snapshot instead), so we say nothing rather than guess.
export default function CommissionNote({ item, month: monthKey }) {
  // monthKey is the raw 'YYYY-MM' column value; every other date on these
  // pages goes through getMonthLabel, so match them rather than printing 2026-08.
  const month = monthKey ? getMonthLabel(monthKey) : null;
  const pct  = Number(item?.commissionPct) || 0;
  const info = item?._commissionInfo || null;

  if (!pct) {
    return <>No share set on this line, so it pays nothing. Set a percentage in the plan editor.</>;
  }
  if (!info) {
    return <>{pct}% of this brand&apos;s GMV, once its monthly GMV goal is reached.</>;
  }

  const sym  = currencySymbol(info.currency);
  const n    = (v) => Number(v || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
  const goal = info.target;

  // No goal in Brand Analytics = nothing to measure against. Deliberately NOT
  // treated as "goal of zero, therefore reached" — that reading would pay
  // commission on every brand nobody has configured yet.
  if (goal == null || !(Number(goal) > 0)) {
    return (
      <>
        <strong>No GMV goal set for {month || 'this month'}</strong> on this brand in Brand
        Analytics, so this line cannot pay. Add the goal there and it starts tracking.
      </>
    );
  }

  if (!info.hit) {
    const short = Number(goal) - Number(info.achieved || 0);
    return (
      <>
        Pays {pct}% of GMV once this brand reaches its {month || 'monthly'} goal of{' '}
        <strong>{sym}{n(goal)}</strong>. Currently {sym}{n(info.achieved)} —{' '}
        {sym}{n(short)} to go, so it stands at zero.
      </>
    );
  }

  // Goal reached but no rate to convert with. The payout RPC refuses in this
  // state rather than freezing a real commission at zero, so say so plainly
  // here instead of letting it look like the line simply earns nothing.
  if (info.fxRate == null) {
    return (
      <>
        <strong>Goal reached</strong> ({sym}{n(info.achieved)} against {sym}{n(goal)}), but there is
        no {info.currency}&nbsp;&rarr;&nbsp;PKR rate for {month || 'this month'} yet, so the payout
        cannot be worked out. A Boss sets it under <strong>Settings &rarr; Payout Rates</strong>.
      </>
    );
  }

  const inBrandCurrency = (Number(info.achieved) || 0) * (Math.min(Math.max(pct, 0), 100) / 100);
  // Compare the RAW keys — `month` is now a display label and would never match.
  const stale = info.fxMonth && monthKey && info.fxMonth !== monthKey;
  return (
    <>
      <strong>Goal reached</strong> — {sym}{n(info.achieved)} against {sym}{n(goal)}. {pct}% of that
      is {sym}{n(inBrandCurrency)}, paid as <strong>PKR {n(Math.round(inBrandCurrency * info.fxRate))}</strong>{' '}
      at {n(info.fxRate)}/{info.currency}
      {stale && <> (carried from the {getMonthLabel(info.fxMonth)} rate — no {month} rate set yet)</>}. Updates daily
      as GMV grows, and locks when the payout is cleared.
    </>
  );
}
