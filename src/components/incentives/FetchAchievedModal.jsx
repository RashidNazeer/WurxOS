// ============================================================
// Fill every APC's ACHIEVED figures for the selected month from the brand
// workbook, after a preview.
//
// Reads each brand tab's achieved column, matches it to the workbook-linked
// lines (wbOption + brandId) on all APCs' plans, and shows exactly what would
// change -- including which lines would flip complete, since completion is what
// pays out. Nothing is written until Apply, and only ticked rows are.
//
// Plans are read STORED (listStoredPlans), not through the read-time overlay,
// and written with updateIncentivesProgress -- the same funnel the page's own
// edits use -- so an attendance / GMV-Max figure can never be frozen into data.
// Each APC is re-read right before its write so a concurrent edit isn't clobbered.
// Verified plans stay verified, as with every other edit the OL makes; paid
// plans are never touched (the builder skips them).
// ============================================================
import { useEffect, useMemo, useRef, useState } from 'react';
import { OPTION_BY_KEY } from '../../lib/incentiveWorkbook';
import { buildAchievedUpdates, applyChangesToPlan, optionForLine } from '../../lib/incentiveAchieved';
import { listBrandMetricsForMonth, saveBrandGmvAchieved } from '../../lib/brandMetricsApi';
import { karachiMonth } from '../../lib/serverTime';
import { fetchWorkbookBuffer, parseWorkbookForBrands } from '../../lib/incentiveWorkbookLoad';
import { getIncentiveWorkbookUrl, listStoredPlans, updateIncentivesProgress } from '../../lib/incentivesApi';

const keyOf = (c) => `${c.userId}|${c.section}|${c.lineId}`;

function fmt(optionKey, v) {
  const unit = OPTION_BY_KEY[optionKey]?.unit;
  if (unit === 'ratio') return `${v}%`;
  if (unit === 'money') return Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return Number(v).toLocaleString();
}

const pill = (bg, color) => ({ padding: '2px 8px', borderRadius: 'var(--radius-pill)', fontSize: 11, fontWeight: 700, background: bg, color, whiteSpace: 'nowrap' });

const sharedSource = () => `the shared sheet, fetched at ${new Date().toLocaleTimeString()}`;

export default function FetchAchievedModal({ users, month, monthLabel, onApplied, onClose }) {
  const [plans, setPlans] = useState(null);
  const [sheets, setSheets] = useState(null);     // brandId -> readBrandSheet() result | { missing: true }
  const [link, setLink] = useState(null);
  const [source, setSource] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [checked, setChecked] = useState(() => new Set());
  const [gmvBefore, setGmvBefore] = useState(null);  // brandId -> brand_monthly_metrics.gmv_achieved; null if unreadable
  const [metricChecked, setMetricChecked] = useState(() => new Set());
  const [phase, setPhase] = useState('preview');   // preview | applying | done
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [results, setResults] = useState([]);
  const mounted = useRef(true);
  const busy = useRef(false);

  async function run(getBuffer, from) {
    setError(''); setSheets(null); setLoading(true);
    try {
      const names = new Map(users.map((u) => [u.id, u.userName]));
      const stored = await listStoredPlans(month, users.map((u) => u.id));
      const ps = stored.map((p) => ({ ...p, userName: names.get(p.userId) || '—' }));
      const brands = new Map();
      for (const p of ps) {
        for (const it of [...p.incentives, ...p.bonuses]) {
          if (it?.brandId && (it.source === 'gmv_max' || optionForLine(it))) brands.set(it.brandId, { id: it.brandId, name: it.brandName || '' });
        }
      }
      if (!mounted.current) return;
      setPlans(ps);
      try {
        const rows = await listBrandMetricsForMonth(month);
        if (mounted.current) setGmvBefore(Object.fromEntries(Object.entries(rows).map(([id, r]) => [id, r.gmv_achieved == null ? null : Number(r.gmv_achieved)])));
      } catch { if (mounted.current) setGmvBefore(null); }
      if (!brands.size) { setSheets({}); return; }
      const map = await parseWorkbookForBrands(await getBuffer(), [...brands.values()]);
      if (!mounted.current) return;
      setSheets(map); setSource(from);
    } catch (err) {
      if (mounted.current) setError(err?.message || String(err));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }

  useEffect(() => {
    mounted.current = true;
    (async () => {
      let saved = null;
      try { saved = await getIncentiveWorkbookUrl(); } catch { /* fall back to upload */ }
      if (!mounted.current) return;
      setLink(saved);
      if (saved?.url) run(() => fetchWorkbookBuffer(saved.url), sharedSource());
      else { setLoading(false); setError('No workbook link is saved yet. Save one from an APC plan\'s workbook picker, or upload the file below.'); }
    })();
    return () => { mounted.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const result = useMemo(
    () => (plans && sheets ? buildAchievedUpdates({ plans, sheetsByBrand: sheets, month, gmvMaxBefore: gmvBefore, monthClosed: month < karachiMonth() }) : null),
    [plans, sheets, month, gmvBefore],
  );
  useEffect(() => {
    setChecked(new Set((result?.changes || []).map(keyOf)));
    setMetricChecked(new Set((result?.metricUpdates || []).map((m) => m.brandId)));
  }, [result]);

  const picked = (result?.changes || []).filter((c) => checked.has(keyOf(c)));
  const pickedMetrics = (result?.metricUpdates || []).filter((m) => metricChecked.has(m.brandId));
  const nothingToDo = !result?.changes.length && !result?.metricUpdates.length;
  const byUser = useMemo(() => {
    const m = new Map();
    for (const c of result?.changes || []) m.set(c.userId, [...(m.get(c.userId) || []), c]);
    return m;
  }, [result]);
  // Skips grouped by brand: brand -> reason -> { options, users }, so one broken
  // tab reads as one line instead of one line per APC per option.
  const skippedByBrand = useMemo(() => {
    const brands = new Map(); const plansSkipped = [];
    for (const s of result?.skipped || []) {
      if (!s.brandName) { plansSkipped.push(s); continue; }
      const reasons = brands.get(s.brandName) || new Map();
      const e = reasons.get(s.reason) || { options: new Set(), users: new Set() };
      e.options.add(s.label); e.users.add(s.userName);
      reasons.set(s.reason, e); brands.set(s.brandName, reasons);
    }
    return { brands: [...brands].sort((a, b) => a[0].localeCompare(b[0])), plansSkipped };
  }, [result]);
  const willComplete = picked.filter((c) => c.completedAfter && !c.completedBefore).length;
  const willUncomplete = picked.filter((c) => !c.completedAfter && c.completedBefore).length;
  const hasPlanLines = !!plans?.some((p) => [...p.incentives, ...p.bonuses].some((i) => i?.brandId && (i.source === 'gmv_max' || optionForLine(i))));
  const noColumn = !!result && nothingToDo && result.skipped.some((s) => /achieved column|target column resolved/.test(s.reason));

  function toggle(c) {
    setChecked((prev) => { const n = new Set(prev); const k = keyOf(c); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  }
  const allOn = !!result?.changes.length && picked.length === result.changes.length;
  const toggleAll = () => setChecked(allOn ? new Set() : new Set(result.changes.map(keyOf)));

  async function onFile(e) {
    const f = e.target.files?.[0];
    if (f) run(() => f.arrayBuffer(), `the file ${f.name}`);
  }

  function close() { if (phase !== 'applying') onClose(); }

  async function apply() {
    if (busy.current || (!picked.length && !pickedMetrics.length)) return;
    busy.current = true;
    const groups = new Map();
    for (const c of picked) groups.set(c.userId, [...(groups.get(c.userId) || []), c]);
    setPhase('applying'); setProgress({ done: 0, total: groups.size + pickedMetrics.length });
    const out = [];
    // The brand figure first, so the GMV Max lines it feeds read the new number straight away.
    for (const m of pickedMetrics) {
      const name = `${m.brandName} · brand GMV Max`;
      try {
        await saveBrandGmvAchieved(m.brandId, month, m.after);
        out.push({ name, ok: true, text: `set to ${Number(m.after).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` });
      } catch (err) {
        out.push({ name, ok: false, error: err?.message || String(err) });
      }
      if (mounted.current) setProgress((p) => ({ ...p, done: p.done + 1 }));
    }
    for (const [userId, cs] of groups) {
      try {
        const [fresh] = await listStoredPlans(month, [userId]);
        if (!fresh) throw new Error('the plan no longer exists');
        if (fresh.payoutCleared) throw new Error('payout was cleared in the meantime, left unchanged');
        await updateIncentivesProgress({ rowId: fresh.id, ...applyChangesToPlan(fresh, cs) });
        out.push({ name: cs[0].userName, ok: true, n: cs.length });
      } catch (err) {
        out.push({ name: cs[0].userName, ok: false, error: err?.message || String(err) });
      }
      if (mounted.current) setProgress((p) => ({ ...p, done: p.done + 1 }));
    }
    busy.current = false;
    if (mounted.current) { setResults(out); setPhase('done'); }
    onApplied();
  }

  const okCount = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1080, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'var(--backdrop)', backdropFilter: 'blur(3.9px)' }} onClick={close} />
      <div className="wx-card" style={{ position: 'relative', width: '100%', maxWidth: 820, zIndex: 1, borderRadius: 'var(--radius-xl)', maxHeight: '92vh', display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }}>

        <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <i className="bi bi-journal-arrow-down" style={{ fontSize: 20, color: 'var(--accent)' }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 15, color: 'var(--text-primary)' }}>Fetch achieved from the brand workbook</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{monthLabel} · all APCs · nothing is saved until you press Apply</div>
          </div>
          <button type="button" onClick={close} aria-label="Close" className="wx-btn wx-btn-ghost" style={{ padding: '6px 10px' }} disabled={phase === 'applying'}>
            <i className="bi bi-x-lg" />
          </button>
        </div>

        <div style={{ padding: '16px 22px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>

          {loading && <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}><span className="wx-spinner" /> Reading the workbook and the plans…</div>}

          {error && (
            <div style={{ padding: '10px 12px', borderRadius: 'var(--radius-md)', background: 'var(--danger-soft, rgba(220,38,38,.1))', color: 'var(--danger, #dc2626)', fontSize: 12.5 }}>
              {error}
            </div>
          )}

          {phase === 'preview' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              {link?.url && (
                <button type="button" className="wx-btn wx-btn-ghost" style={{ fontSize: 12 }} disabled={loading}
                  onClick={() => run(() => fetchWorkbookBuffer(link.url), sharedSource())}>
                  <i className="bi bi-arrow-clockwise me-1" /> Reload
                </button>
              )}
              {result && !error && (
                <span style={{ fontSize: 12.5, color: 'var(--success, #16a34a)' }}>
                  <i className="bi bi-check-circle-fill me-1" />Read from {source}
                </span>
              )}
              <details style={{ marginLeft: 'auto' }}>
                <summary style={{ fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}>Upload a file instead</summary>
                <input type="file" accept=".xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  className="wx-input" style={{ width: '100%', marginTop: 8 }} onChange={onFile} />
              </details>
            </div>
          )}

          {phase === 'preview' && result && (
            <>
              {result.changes.length > 0 ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <div style={{ fontWeight: 800, fontSize: 14, color: 'var(--text-primary)', flex: 1, minWidth: 220 }}>
                    {picked.length} of {result.changes.length} change{result.changes.length === 1 ? '' : 's'} selected for {monthLabel}
                  </div>
                  {willComplete > 0 && <span style={pill('var(--success-soft)', 'var(--success-text)')}>{willComplete} will complete</span>}
                  {willUncomplete > 0 && <span style={pill('var(--danger-soft, rgba(220,38,38,.12))', 'var(--danger-text, var(--danger))')}>{willUncomplete} no longer complete</span>}
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, cursor: 'pointer' }}>
                    <input type="checkbox" checked={allOn} onChange={toggleAll} /> Select all
                  </label>
                </div>
              ) : nothingToDo && (
                <div style={{ padding: '12px 14px', borderRadius: 'var(--radius-md)', background: 'var(--surface-2)', fontSize: 13, color: 'var(--text-primary)' }}>
                  {!hasPlanLines
                    ? `No APC plan for ${monthLabel} has workbook-linked lines, so there is nothing to fetch.`
                    : noColumn
                      ? `The workbook has no achieved column for ${monthLabel} yet, so no figures can be fetched. Try again once the month's column is filled in.`
                      : 'Nothing to update: every workbook-linked line already matches the workbook (or could not be read — see "Not filled" below).'}
                </div>
              )}

              {result.metricUpdates.length > 0 && (
                <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
                  <div style={{ padding: '8px 12px', background: 'var(--surface-2)', fontWeight: 700, fontSize: 13 }}>
                    Brand GMV Max figure (feeds every GMV Max line of that brand)
                  </div>
                  {result.metricUpdates.map((m) => (
                    <label key={m.brandId} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 12px', borderTop: '1px solid var(--border-subtle)', cursor: 'pointer', fontSize: 12.5 }}>
                      <input type="checkbox" checked={metricChecked.has(m.brandId)} style={{ marginTop: 3 }}
                        onChange={() => setMetricChecked((prev) => { const n = new Set(prev); if (n.has(m.brandId)) n.delete(m.brandId); else n.add(m.brandId); return n; })} />
                      <span style={{ flex: 1 }}>
                        <strong>{m.brandName}</strong>: {m.before == null ? 'not set' : Number(m.before).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        {' → '}<strong>{Number(m.after).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
                        <span style={{ display: 'block', color: 'var(--text-muted)' }}>{m.lines.join(' · ')}</span>
                      </span>
                    </label>
                  ))}
                </div>
              )}

              {[...byUser].map(([userId, cs]) => {
                const verified = cs.some((c) => c.wasVerified && checked.has(keyOf(c)));
                return (
                  <div key={userId} style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
                    <div style={{ padding: '8px 12px', background: 'var(--surface-2)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-primary)' }}>{cs[0].userName}</span>
                      {verified && (
                        <span style={pill('var(--warning-soft, rgba(217,119,6,.15))', 'var(--warning-text, #92400e)')} title="Verification is not reset by this change, the same as any other edit the OL makes">
                          <i className="bi bi-patch-check-fill me-1" />Verified plan: figures will change under it
                        </span>
                      )}
                    </div>
                    {cs.map((c) => {
                      const flips = c.completedAfter !== c.completedBefore;
                      return (
                        <label key={keyOf(c)} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 12px', borderTop: '1px solid var(--border-subtle)', cursor: 'pointer' }}>
                          <input type="checkbox" checked={checked.has(keyOf(c))} onChange={() => toggle(c)} style={{ marginTop: 3 }} />
                          <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: 'var(--text-primary)' }}>
                            <strong>{c.brandName}</strong> · {c.label}
                            <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                              {fmt(c.optionKey, c.before)} → <strong style={{ color: 'var(--text-primary)' }}>{fmt(c.optionKey, c.after)}</strong>
                              {c.detail ? ` · ${c.detail}` : ''}
                            </div>
                          </span>
                          {flips && (c.completedAfter
                            ? <span style={pill('var(--success-soft)', 'var(--success-text)')}>will complete</span>
                            : <span style={pill('var(--danger-soft, rgba(220,38,38,.12))', 'var(--danger-text, var(--danger))')}>no longer complete</span>)}
                        </label>
                      );
                    })}
                  </div>
                );
              })}

              {result.skipped.length > 0 && (
                <details open={skippedByBrand.brands.length <= 12}>
                  <summary style={{ fontSize: 12.5, color: 'var(--warning-text)', cursor: 'pointer', fontWeight: 600 }}>
                    Not filled: {skippedByBrand.brands.length} brand{skippedByBrand.brands.length === 1 ? '' : 's'}
                    {skippedByBrand.plansSkipped.length ? ` + ${skippedByBrand.plansSkipped.length} plan${skippedByBrand.plansSkipped.length === 1 ? '' : 's'}` : ''}
                  </summary>
                  <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {skippedByBrand.brands.map(([brand, reasons]) => (
                      <div key={brand} style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        <strong style={{ color: 'var(--text-primary)' }}>{brand}</strong>
                        {[...reasons].map(([reason, e]) => (
                          <div key={reason} style={{ paddingLeft: 10 }}>
                            {reason}
                            <span style={{ opacity: 0.8 }}> — {[...e.options].join(', ')} ({[...e.users].join(', ')})</span>
                          </div>
                        ))}
                      </div>
                    ))}
                    {skippedByBrand.plansSkipped.map((s, i) => (
                      <div key={`p${i}`} style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        <strong style={{ color: 'var(--text-primary)' }}>{s.userName}</strong>: {s.reason}
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </>
          )}

          {phase === 'applying' && (
            <div style={{ fontSize: 13, color: 'var(--text-primary)' }}>
              <span className="wx-spinner" /> Saving {progress.done} of {progress.total} APCs…
            </div>
          )}

          {phase === 'done' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontWeight: 800, fontSize: 14, color: failed.length ? 'var(--warning-text, #92400e)' : 'var(--success-text)' }}>
                <i className={`bi ${failed.length ? 'bi-exclamation-triangle-fill' : 'bi-check-circle-fill'} me-1`} />
                {okCount} of {results.length} update{results.length === 1 ? '' : 's'} saved{failed.length ? `, ${failed.length} failed` : ''}
              </div>
              {results.filter((r) => r.ok).map((r) => (
                <div key={r.name} style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{r.name}: {r.text || `${r.n} line${r.n === 1 ? '' : 's'} updated`}</div>
              ))}
              <div>
                <button type="button" className="wx-btn wx-btn-ghost" style={{ fontSize: 12 }}
                  onClick={() => { setPhase('preview'); setResults([]); if (link?.url) run(() => fetchWorkbookBuffer(link.url), sharedSource()); }}>
                  <i className="bi bi-arrow-clockwise me-1" /> Read the workbook again
                </button>
              </div>
              {failed.map((r) => (
                <div key={r.name} style={{ padding: '8px 12px', borderRadius: 'var(--radius-md)', background: 'var(--danger-soft, rgba(220,38,38,.1))', color: 'var(--danger, #dc2626)', fontSize: 12.5 }}>
                  <strong>{r.name}</strong> was not saved: {r.error}
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ padding: '14px 22px', borderTop: '1px solid var(--border-subtle)', display: 'flex', gap: 8 }}>
          <div style={{ flex: 1, fontSize: 12, color: 'var(--text-muted)', alignSelf: 'center' }}>
            Writes achieved figures only; targets and amounts are untouched.
          </div>
          <button type="button" className="wx-btn wx-btn-ghost" onClick={close} disabled={phase === 'applying'}>
            {phase === 'done' ? 'Close' : 'Cancel'}
          </button>
          {phase === 'preview' && (
            <button type="button" className="wx-btn wx-btn-primary" onClick={apply} disabled={loading || (!picked.length && !pickedMetrics.length)}>
              <i className="bi bi-check2 me-1" /> Apply {picked.length + pickedMetrics.length} change{picked.length + pickedMetrics.length === 1 ? '' : 's'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
