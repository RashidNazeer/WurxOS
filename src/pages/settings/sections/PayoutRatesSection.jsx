import { useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { listPayoutFxRates, setPayoutFxRate, deletePayoutFxRate, getMonthLabel } from '../../../lib/incentivesApi';
import { currencySymbol } from '../../../utils/currencies';
import { ShieldIcon, AlertIcon, CheckIcon } from '../../../components/common/Icon';
import SectionShell from './SectionShell';

// Exchange rates used to pay Commission Based Tier incentive lines (mig 333).
//
// Everything else in the incentives module is PKR by convention. A commission
// is a percentage of a brand's GMV, and GMV is in the CLIENT's currency, so it
// has to be converted before it can be added to a payslip. Without a rate the
// line reads zero and clearing the payout is refused outright — that refusal is
// deliberate, because freezing a real commission at zero would be invisible.
//
// Rates are per month, not one live rate: entering September's number must not
// retroactively change what August's unpaid lines are worth.
function monthNow() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function shiftMonth(ym, by) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + by, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export default function PayoutRatesSection() {
  const [month, setMonth]       = useState(monthNow());
  const [currencies, setCurrencies] = useState([]);   // in use by active brands
  const [rates, setRates]       = useState({});       // { USD: '279.50' }
  const [saved, setSaved]       = useState({});       // what is actually stored
  const [loading, setLoading]   = useState(true);
  const [savingCur, setSavingCur] = useState('');
  const [err, setErr]           = useState('');
  const [ok, setOk]             = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setErr('');
    (async () => {
      // Only offer the currencies that actually bill in something other than
      // PKR — an empty list of rates to fill in is the right answer when every
      // brand is already PKR.
      const { data: brands, error } = await supabase
        .from('brands').select('currency, brand_name').eq('status', 'active');
      if (error) throw new Error(error.message);
      const byCur = {};
      (brands || []).forEach((b) => {
        const c = (b.currency || 'USD').toUpperCase();
        if (c === 'PKR') return;                       // 1:1, nothing to set
        (byCur[c] = byCur[c] || []).push(b.brand_name);
      });
      const rows = await listPayoutFxRates(month);
      // Normalise through Number: Postgres hands back "280.00" for a numeric,
      // and the save path stores String(Number(v)) — comparing the two raw
      // strings would show a freshly-loaded, untouched rate as unsaved.
      const stored = Object.fromEntries(rows.map((r) => [r.currency, String(Number(r.rate))]));
      if (cancelled) return;
      setCurrencies(Object.entries(byCur)
        .map(([code, names]) => ({ code, count: names.length, sample: names.sort().slice(0, 3) }))
        .sort((a, b) => b.count - a.count));
      setSaved(stored);
      setRates(stored);
      setLoading(false);
    })().catch((e) => { if (!cancelled) { setErr(e.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [month]);

  async function save(code) {
    setErr(''); setOk(''); setSavingCur(code);
    try {
      const v = rates[code];
      if (v === '' || v == null) {
        await deletePayoutFxRate(month, code);
        setSaved((s) => { const n = { ...s }; delete n[code]; return n; });
        setOk(`${code} rate cleared for ${getMonthLabel(month)}.`);
      } else {
        await setPayoutFxRate(month, code, v);
        // Canonicalise BOTH sides. The dirty check compares them as strings, so
        // storing String(Number(v)) while leaving the typed "279.50" in the box
        // would leave a just-saved rate showing as unsaved forever.
        const canon = String(Number(v));
        setSaved((s) => ({ ...s, [code]: canon }));
        setRates((r) => ({ ...r, [code]: canon }));
        setOk(`${code} → PKR set to ${Number(v).toLocaleString()} for ${getMonthLabel(month)}.`);
      }
      setTimeout(() => setOk(''), 3500);
    } catch (e) { setErr(e.message || 'Failed to save.'); }
    finally { setSavingCur(''); }
  }

  const isCurrent = month === monthNow();

  return (
    <SectionShell
      icon={ShieldIcon}
      title="Payout rates"
      subtitle="Conversion to PKR for Commission Based Tier incentives. A commission is a share of the brand's GMV, which is in the client's currency — this is what turns it into a figure that can go on a payslip."
    >
      {err && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 10 }}>
          <AlertIcon width="14" height="14" /> <span>{err}</span>
        </div>
      )}
      {ok && (
        <div className="wx-alert wx-alert-success" style={{ marginBottom: 10 }}>
          <CheckIcon width="14" height="14" /> <span>{ok}</span>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm"
          onClick={() => setMonth((m) => shiftMonth(m, -1))}>←</button>
        <span style={{ fontWeight: 600, fontSize: 14, minWidth: 130, textAlign: 'center' }}>
          {getMonthLabel(month)}
        </span>
        <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm"
          onClick={() => setMonth((m) => shiftMonth(m, 1))}>→</button>
        {!isCurrent && (
          <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm" onClick={() => setMonth(monthNow())}>
            Back to this month
          </button>
        )}
      </div>

      {loading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          <span className="wx-spinner" /> Loading…
        </div>
      ) : err ? (
        // Without this, a failed load falls through to the empty-list branch
        // and reports "every brand bills in PKR" — an affirmative, wrong answer
        // to a question that was never actually answered.
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          Could not load the rates. The error is shown above.
        </div>
      ) : currencies.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          Every active brand already bills in PKR, so there is nothing to convert.
        </div>
      ) : (
        <>
          <div style={{ display: 'grid', gap: 10 }}>
            {currencies.map(({ code, count, sample }) => {
              const dirty = String(rates[code] ?? '') !== String(saved[code] ?? '');
              const unset = saved[code] == null;
              return (
                <div key={code} style={{
                  display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                  padding: '10px 12px', borderRadius: 10,
                  border: `1px solid ${unset ? 'var(--warning, #fd7e14)' : 'var(--border)'}`,
                  background: unset ? 'rgba(253,126,20,0.06)' : 'transparent',
                }}>
                  <div style={{ minWidth: 150, flex: '1 1 150px' }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>
                      {currencySymbol(code)} 1 {code} =
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {count} brand{count === 1 ? '' : 's'} · {sample.join(', ')}{count > sample.length ? '…' : ''}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input
                      type="number" min="0" step="0.01" placeholder="e.g. 279.50"
                      className="wx-input"
                      style={{ width: 130 }}
                      value={rates[code] ?? ''}
                      onChange={(e) => setRates((r) => ({ ...r, [code]: e.target.value }))}
                    />
                    <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>PKR</span>
                  </div>
                  <button
                    type="button"
                    className={`wx-btn wx-btn-sm ${dirty ? 'wx-btn-primary' : 'wx-btn-ghost'}`}
                    disabled={!dirty || savingCur === code}
                    onClick={() => save(code)}
                  >
                    {/* "Saved" would be a lie on a row that has never had a
                        rate — nothing is saved, the box is simply empty. */}
                    {savingCur === code ? 'Saving…' : dirty ? 'Save' : unset ? '—' : 'Saved'}
                  </button>
                  {unset && (
                    <span style={{ fontSize: 11, color: 'var(--warning, #fd7e14)', fontWeight: 600 }}>
                      Not set for {getMonthLabel(month)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 12, marginBottom: 0 }}>
            A month with no rate of its own falls back to the most recent earlier month, and the
            incentive line says which one it used. Clearing a payout is blocked outright while a
            brand has reached its goal and has no rate at all — better a visible refusal than a
            commission silently frozen at zero.
          </p>
        </>
      )}
    </SectionShell>
  );
}
