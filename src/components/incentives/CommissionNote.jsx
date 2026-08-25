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

  // A blank benchmark is a real mode, not a missing field: with nothing to
  // clear, the commission is paid on everything achieved. Say which mode the
  // line is in, because "5% of $100" and "5% of the $200 above $1,000" are very
  // different promises and the line itself does not look any different.
  if (!pct) {
    return <>No commission percentage set on this line, so it pays nothing.</>;
  }

  if (excess <= 0) {
    // With no benchmark, "no excess" can only mean nothing has been achieved —
    // saying "above its $0 benchmark" there would be nonsense.
    return benchmark > 0 ? (
      <>
        Pays {pct}% of whatever this brand earns above its {sym}{n(benchmark)} benchmark.
        Achieved so far is {sym}{n(achieved)}, so there is no excess yet and it stands at zero.
      </>
    ) : (
      <>Pays {pct}% of everything this brand achieves, with no benchmark to clear first.
        Nothing recorded yet, so it stands at zero.</>
    );
  }

  const basis = benchmark > 0
    ? <>{sym}{n(achieved)} − {sym}{n(benchmark)} = <strong>{sym}{n(excess)}</strong> above the benchmark</>
    : <><strong>No benchmark</strong>, so this pays on the whole {sym}{n(achieved)} achieved</>;

  // Earning, but no rate to convert with. The payout RPC refuses in this state
  // rather than freezing real earnings at zero, so say so plainly here instead
  // of letting it look like the line simply pays nothing.
  if (!info || info.fxRate == null) {
    return (
      <>
        {basis}, and {pct}% of that is <strong>{sym}{n(earnedRaw)}</strong> — but there is no{' '}
        {info?.currency || 'currency'}&nbsp;&rarr;&nbsp;PKR rate for {month || 'this month'} yet, so
        it cannot be converted. A Boss sets it under <strong>Settings &rarr; Payout Rates</strong>.
      </>
    );
  }

  const stale = info.fxMonth && monthKey && info.fxMonth !== monthKey;
  return (
    <>
      {basis}. {pct}% of that is {sym}{n(earnedRaw)}, paid as{' '}
      <strong>PKR {n(Math.round(earnedRaw * info.fxRate))}</strong> at {n(info.fxRate)}/{info.currency}
      {stale && <> (carried from the {getMonthLabel(info.fxMonth)} rate — no {month} rate set yet)</>}.
      Locks when the payout is cleared.
    </>
  );
}
