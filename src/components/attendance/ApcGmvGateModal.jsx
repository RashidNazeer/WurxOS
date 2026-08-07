import React, { useEffect, useState } from 'react';
import { currencySymbol, fmtMoney } from '../../utils/currencies';

// APC clock-in gate: enter each active brand's month-to-date GMV, review, confirm.
// On confirm the parent saves the GMV (overwrites each brand's Achieved) then
// clocks the user in. Two steps: enter -> review. Matches the app's wx-m-* modal.

const STEPS = [
  { key: 'enter',  label: 'Enter GMV' },
  { key: 'review', label: 'Confirm' },
];

// Digits + a single decimal point only — strips commas, letters ("K"/"M"), symbols.
function sanitizeNum(v) {
  let s = (v || '').replace(/[^\d.]/g, '');
  const i = s.indexOf('.');
  if (i !== -1) s = s.slice(0, i + 1) + s.slice(i + 1).replace(/\./g, '');
  return s;
}
function isValidNum(s) {
  if (s == null || s === '' || s === '.') return false;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0;
}
function fmtDay(iso, opts) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { timeZone: 'UTC', ...opts });
}
function fmtRange(start, end) {
  if (!start || !end) return '—';
  const sameMonth = start.slice(0, 7) === end.slice(0, 7);
  const yr = fmtDay(end, { year: 'numeric' });
  if (sameMonth) {
    return `${Number(start.slice(8, 10))} – ${Number(end.slice(8, 10))} ${fmtDay(end, { month: 'short' })} ${yr}`;
  }
  return `${fmtDay(start, { day: 'numeric', month: 'short' })} – ${fmtDay(end, { day: 'numeric', month: 'short' })} ${yr}`;
}
function monthLabel(monthKey) {
  if (!monthKey) return 'this month';
  const [y, m] = monthKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' });
}
function monthEndIso(monthKey) {
  if (!monthKey) return undefined;
  const [y, m] = monthKey.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${monthKey}-${String(last).padStart(2, '0')}`;
}

export default function ApcGmvGateModal({ status, onConfirm, onClose }) {
  const brands = status?.brands || [];
  const monthKey = status?.month_key || '';
  const firstOfMonth = status?.range_start || (monthKey ? `${monthKey}-01` : '');
  const monthEnd = monthEndIso(monthKey);

  const [step, setStep] = useState(0);
  const [values, setValues] = useState(() => Object.fromEntries(brands.map((b) => [b.id, ''])));
  const [rangeStart, setRangeStart] = useState(status?.range_start || '');
  const [rangeEnd, setRangeEnd] = useState(status?.range_end || '');
  const [editDates, setEditDates] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState('');

  // Both dates must stay inside the current month (the value is month-to-date).
  const inMonth = (d) => !!d && d.slice(0, 7) === monthKey;
  const datesOk = inMonth(rangeStart) && inMonth(rangeEnd) && rangeStart <= rangeEnd;
  const allFilled = brands.length > 0 && brands.every((b) => isValidNum(values[b.id]));
  const canContinue = allFilled && datesOk;

  async function doConfirm() {
    if (!canContinue || submitting) return;
    setErr(''); setSubmitting(true);
    try {
      await onConfirm({
        entries: brands.map((b) => ({ brand_id: b.id, gmv: Number(values[b.id]) })),
        rangeStart, rangeEnd,
      });
      // parent unmounts this modal on success
    } catch (e) {
      setErr(e?.message || 'Could not save. Please try again.');
      setSubmitting(false);
    }
  }

  useEffect(() => {
    function onKey(e) {
      if (submitting) return;
      if (e.key === 'Escape') onClose();
      else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        if (step === 0 && canContinue) setStep(1);
        else if (step === 1) doConfirm();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, canContinue, submitting, values, rangeStart, rangeEnd]);

  return (
    <div className="wx-modal-backdrop wx-m-backdrop" onClick={submitting ? undefined : onClose}>
      <div className="wx-modal" style={{ maxWidth: 500 }} onClick={(e) => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-labelledby="apc-gmv-title">
        <div className="wx-m-head">
          <div className="wx-m-head-icon"><i className="bi bi-graph-up-arrow" style={{ fontSize: 18 }} /></div>
          <div className="wx-m-head-text">
            <div className="wx-m-head-title" id="apc-gmv-title">Enter today's GMV</div>
            <div className="wx-m-head-sub">Add each brand's month-to-date GMV, then you'll be clocked in.</div>
          </div>
          {!submitting && (
            <button type="button" className="wx-m-head-close" onClick={onClose} aria-label="Close">
              <i className="bi bi-x-lg" style={{ fontSize: 12 }} />
            </button>
          )}
        </div>

        <div className="wx-m-stepper">
          {STEPS.map((s, i) => (
            <span key={s.key} className={`wx-m-step ${i === step ? 'is-active' : i < step ? 'is-done' : ''}`}>
              <span className="wx-m-step-dot">{i < step ? <i className="bi bi-check-lg" /> : i + 1}</span>
              {s.label}
              {i < STEPS.length - 1 && <span className="wx-m-step-sep" style={{ width: 24, flex: 'none' }} />}
            </span>
          ))}
        </div>

        <div className="wx-m-body">
          {err && <div className="wx-alert wx-alert-danger"><i className="bi bi-exclamation-triangle" /> <span>{err}</span></div>}

          {/* Period */}
          <div className="wx-m-field">
            <div className="wx-m-field-head">
              <div className="wx-m-field-label">Period</div>
              {step === 0 && (
                <button type="button" className="wx-m-field-meta" onClick={() => setEditDates((v) => !v)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent)' }}>
                  {editDates ? 'Done' : 'Wrong dates? Edit'}
                </button>
              )}
            </div>
            {step === 0 && editDates ? (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 8, alignItems: 'center' }}>
                <input type="date" className="wx-m-input" aria-label="Period start date"
                  value={rangeStart} min={firstOfMonth} max={rangeEnd || monthEnd}
                  onChange={(e) => setRangeStart(e.target.value)} />
                <i className="bi bi-arrow-right" style={{ color: 'var(--text-muted)' }} />
                <input type="date" className="wx-m-input" aria-label="Period end date"
                  value={rangeEnd} min={rangeStart || firstOfMonth} max={monthEnd}
                  onChange={(e) => setRangeEnd(e.target.value)} />
              </div>
            ) : (
              <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text-primary)' }}>{fmtRange(rangeStart, rangeEnd)}</div>
            )}
            {!datesOk && <div style={{ fontSize: 11.5, color: 'var(--danger)', marginTop: 2 }}>Pick a start and end date within {monthLabel(monthKey)}.</div>}
          </div>

          {step === 0 ? (
            <>
              {brands.map((b, i) => (
                <div className="wx-m-field" key={b.id}>
                  <div className="wx-m-field-head">
                    <div className="wx-m-field-label">{b.name}</div>
                    <div className="wx-m-field-meta is-required">{b.currency}</div>
                  </div>
                  <div className="wx-m-input-shell">
                    <span className="wx-m-input-prefix">{currencySymbol(b.currency)}</span>
                    <input
                      inputMode="decimal" autoComplete="off" placeholder="0"
                      autoFocus={i === 0}
                      aria-label={`${b.name} month-to-date GMV in ${b.currency}`}
                      value={values[b.id] ?? ''}
                      onChange={(e) => setValues((prev) => ({ ...prev, [b.id]: sanitizeNum(e.target.value) }))}
                    />
                  </div>
                </div>
              ))}
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.45 }}>
                <i className="bi bi-info-circle me-1" />
                Enter the <strong>total</strong> GMV for the period above — numbers only (no commas or “K”). This updates each brand's <strong>Achieved</strong> for {monthLabel(monthKey)}.
              </div>
            </>
          ) : (
            <div className="wx-m-review">
              <div className="wx-m-review-row">
                <div className="wx-m-review-k">Period</div>
                <div className="wx-m-review-v">{fmtRange(rangeStart, rangeEnd)}</div>
              </div>
              {brands.map((b) => (
                <div key={b.id} className="wx-m-review-row" style={{ gridTemplateColumns: '1fr auto', alignItems: 'center' }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', minWidth: 0, wordBreak: 'break-word' }}>{b.name}</div>
                  <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                    {fmtMoney(Number(values[b.id] || 0), b.currency)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="wx-m-foot">
          <div className="wx-m-kbd-hints">
            <kbd>Esc</kbd> cancel <span>·</span> <kbd>⌘</kbd><kbd>↵</kbd> {step === 0 ? 'next' : 'confirm'}
          </div>
          <div className="wx-m-foot-actions">
            {step === 1 && <button type="button" className="wx-btn wx-btn-ghost" onClick={() => setStep(0)} disabled={submitting}>Back</button>}
            {step === 0 ? (
              <button type="button" className="wx-btn wx-btn-primary" onClick={() => canContinue && setStep(1)} disabled={!canContinue}>
                Review <i className="bi bi-arrow-right" />
              </button>
            ) : (
              <button type="button" className="wx-btn wx-btn-primary" onClick={doConfirm} disabled={submitting}>
                {submitting ? <><span className="wx-spinner" /> Saving…</> : <><i className="bi bi-check-lg" /> Confirm &amp; clock in</>}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
