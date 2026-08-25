import { currencySymbol } from '../../utils/currencies';
import {
  getMonthLabel, commissionBenchmark, commissionAchieved,
  commissionExcess, commissionEarnedRaw,
} from '../../lib/incentivesApi';

// The one-line explanation under a Commission Based Tier item (migs 333-336).
//
// This exists because the number on a commission line is the only money in the
// incentives module that nobody typed directly: it is three hand-entered
// figures and an exchange rate deep. When it reads zero — which is the normal
// state until the benchmark is passed — the person looking at it deserves to
// know WHICH of those is the reason, rather than assuming it is broken.
//
// `_commissionInfo` carries the brand's currency and the month's rate; it is
// attached by applyCommissionAutofill at read time and never persisted. When it
// is absent the overlay has not run (a paid row reads its frozen snapshot
// instead), so the note falls back to what the item itself can prove.
export default function CommissionNote({ item, month: monthKey }) {
  // monthKey is the raw 'YYYY-MM' column value; every other date on these pages
  // goes through getMonthLabel, so match them rather than printing 2026-08.
  const month = monthKey ? getMonthLabel(monthKey) : null;
  const info  = item?._commissionInfo || null;
  const sym   = currencySymbol(info?.currency || 'USD');
  const n     = (v) => Number(v || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

  const pct       = Number(item?.commissionPct) || 0;
  const benchmark = commissionBenchmark(item);
  const achieved  = commissionAchieved(item);
  const excess    = commissionExcess(item);
  const earnedRaw = commissionEarnedRaw(item);

  // A benchmark of zero is not "a benchmark of zero" — it is almost always a
  // field nobody filled in, and paying on `achieved - 0` would be the entire
  // achieved figure. Say so instead of quietly showing nothing.
  if (!(benchmark > 0)) {
    return (
      <>
        <strong>No GMV benchmark set</strong> on this line, so there is nothing to measure the
        excess against and it pays nothing. An Operations Lead sets it in the plan editor.
      </>
    );
  }
  if (!pct) {
    return <>No commission percentage set on this line, so it pays nothing.</>;
  }

  if (excess <= 0) {
    return (
      <>
        Pays {pct}% of whatever this brand earns above its {sym}{n(benchmark)} benchmark.
        Achieved so far is {sym}{n(achieved)}, so there is no excess yet and it stands at zero.
      </>
    );
  }

  // Earning, but no rate to convert with. The payout RPC refuses in this state
  // rather than freezing real earnings at zero, so say so plainly here instead
  // of letting it look like the line simply pays nothing.
  if (!info || info.fxRate == null) {
    return (
      <>
        {sym}{n(achieved)} − {sym}{n(benchmark)} = <strong>{sym}{n(excess)}</strong> above the
        benchmark, and {pct}% of that is <strong>{sym}{n(earnedRaw)}</strong> — but there is no{' '}
        {info?.currency || 'currency'}&nbsp;&rarr;&nbsp;PKR rate for {month || 'this month'} yet, so
        it cannot be converted. A Boss sets it under <strong>Settings &rarr; Payout Rates</strong>.
      </>
    );
  }

  const stale = info.fxMonth && monthKey && info.fxMonth !== monthKey;
  return (
    <>
      {sym}{n(achieved)} − {sym}{n(benchmark)} = <strong>{sym}{n(excess)}</strong> above the
      benchmark. {pct}% of that is {sym}{n(earnedRaw)}, paid as{' '}
      <strong>PKR {n(Math.round(earnedRaw * info.fxRate))}</strong> at {n(info.fxRate)}/{info.currency}
      {stale && <> (carried from the {getMonthLabel(info.fxMonth)} rate — no {month} rate set yet)</>}.
      Locks when the payout is cleared.
    </>
  );
}
