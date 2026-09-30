import { useCallback, useEffect, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { usageSummary, setMonthlyBudget } from '../../lib/buddyApi';
import { LoadError } from '../../components/buddy/BuddyThread';
import { KEY_SLOT_LABEL, USAGE_KIND_LABEL, fmtCount, fmtMs, fmtPct, fmtUsd, pktDate, usageRange } from '../../lib/buddyLogic';

// Buddy settings → Usage (Boss only; ai_usage_summary refuses anyone else).
// Estimates from our own request log × the configured prices; the OpenAI
// dashboard is the exact bill. Lazy-loaded (it pulls in recharts).

const PRESETS = [['7d', '7 days'], ['30d', '30 days'], ['month', 'This month'], ['custom', 'Custom']];
const SURFACE_LABEL = { full: 'Buddy tab', quick: 'Quick panel', slack: 'Slack relay', unknown: 'Unknown' };

export default function BuddyUsage() {
  const [preset, setPreset] = useState('30d');
  const [custom, setCustom] = useState(() => usageRange('30d'));
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const range = preset === 'custom' ? custom : usageRange(preset);
  const load = useCallback(async () => {
    if (!range.from || !range.to || range.from > range.to) { setErr('range'); return; }
    setLoading(true); setErr('');
    try { setData(await usageSummary(range.from, range.to)); }
    catch (e) { setErr(e.message === 'not allowed' ? 'boss' : 'load'); }
    finally { setLoading(false); }
  }, [range.from, range.to]);
  useEffect(() => { load(); }, [load]);

  const t = data?.totals || {};
  const o = data?.outcomes || {};
  const mtd = data?.month_to_date || {};

  return (
    <section className="bd-card" aria-labelledby="bd-usage-title">
      <div className="bd-card-head">
        <i className="bi bi-graph-up" aria-hidden="true" />
        <div>
          <h3 id="bd-usage-title" className="bd-card-title">Usage and cost</h3>
          <div className="bd-card-sub">Estimated OpenAI spend for Buddy, in USD. Dates are Pakistan time.</div>
        </div>
      </div>

      <div className="bd-usage-range" role="group" aria-label="Date range">
        {PRESETS.map(([k, label]) => (
          <button key={k} type="button" className={`bd-pill ${preset === k ? 'is-on' : ''}`} aria-pressed={preset === k} onClick={() => setPreset(k)}>{label}</button>
        ))}
        {preset === 'custom' && (
          <span className="bd-usage-dates">
            <input type="date" className="form-control form-control-sm" aria-label="From" value={custom.from} max={pktDate()}
              onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
            <span aria-hidden="true">–</span>
            <input type="date" className="form-control form-control-sm" aria-label="To" value={custom.to} max={pktDate()}
              onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
          </span>
        )}
        {loading && <span className="wx-spinner" style={{ color: 'var(--accent)' }} aria-label="Loading" />}
      </div>

      {err && (err === 'range'
        ? <div className="bd-error mb-2" role="alert">Pick a start date on or before the end date.</div>
        : err === 'boss'
          ? <div className="bd-card-sub mb-2">Usage is visible to the Boss only.</div>
          : <LoadError what="usage" onRetry={load} compact />)}
      {!data && !err && <UsageSkeleton />}
      {data && (
        <>
          <div className="bd-stats bd-usage-cards">
            <Tile label="This month so far" value={fmtUsd(mtd.est_cost_usd)} sub={mtd.days_elapsed ? `${mtd.days_elapsed} of ${mtd.days_in_month} days` : null} />
            <Tile label="Projected month end" value={fmtUsd(mtd.projected_month_usd)} />
            <Tile label="Budget" value={mtd.budget_usd ? fmtPct(mtd.budget_used_pct) : 'No budget set'}
              sub={mtd.budget_usd ? `of ${fmtUsd(mtd.budget_usd)} · projected ${fmtPct(mtd.projected_budget_pct)}` : null}
              warn={Number(mtd.projected_budget_pct) > 100} />
            <Tile label="Questions" value={fmtCount(t.questions)} sub={`${fmtUsd(t.est_cost_usd)} in range`} />
            <Tile label="Avg latency" value={fmtMs(o.avg_latency_ms)} sub={o.p95_latency_ms != null ? `p95 ${fmtMs(o.p95_latency_ms)}` : null} />
          </div>

          <DailyChart days={data.by_day || []} />

          <div className="bd-usage-outcomes" aria-label="Outcomes">
            <span><b>{fmtCount(o.errors)}</b> errors</span>
            <span><b>{fmtCount(o.cancelled)}</b> stopped</span>
            <span><b>{fmtCount(o.deadline_hit)}</b> timed out</span>
            <span><b>{fmtCount(o.rate_limited)}</b> rate-limited</span>
          </div>

          <div className="bd-usage-grid">
            <UsageTable title="By person" head={['Name', 'Role', 'Questions', 'Cost']}
              rows={(data.by_user || []).map((u) => [u.name || 'Unknown', u.role || '—', fmtCount(u.questions), fmtUsd(u.est_cost_usd)])} />
            <UsageTable title="By surface" head={['Where', 'Questions', 'Cost']}
              rows={Object.entries(data.by_surface || {}).map(([k, v]) => [SURFACE_LABEL[k] || k, fmtCount(v.questions), fmtUsd(v.est_cost_usd)])} />
            <UsageTable title="By model" head={['Model', 'Calls', 'Tokens in', 'Cached', 'Tokens out', 'Cost']}
              rows={(data.by_model || []).map((m) => [m.model, fmtCount(m.calls), fmtCount(m.tokens_in), fmtCount(m.tokens_cached), fmtCount(m.tokens_out), fmtUsd(m.est_cost_usd)])} />
            <UsageTable title="By kind" head={['Kind', 'Calls', 'Tokens in', 'Tokens out', 'Cost']}
              rows={Object.entries(data.by_kind || {}).map(([k, v]) => [USAGE_KIND_LABEL[k] || k, fmtCount(v.calls), fmtCount(v.tokens_in), fmtCount(v.tokens_out), fmtUsd(v.est_cost_usd)])} />
            <UsageTable title="By key" head={['Key', 'Questions', 'Fallback used', 'Cost']}
              rows={Object.entries(data.by_key_slot || {}).map(([k, v]) => [KEY_SLOT_LABEL[k] || k, fmtCount(v.questions), fmtCount(v.fallback_used), fmtUsd(v.est_cost_usd)])} />
          </div>

          {Number(data.unpriced?.calls) > 0 && (
            <div className="bd-usage-outcomes" role="note">
              <span><b>{fmtCount(data.unpriced.calls)}</b> calls on models with no price set (counted as $0): {(data.unpriced.models || []).join(', ') || 'unknown'}</span>
              <span>{fmtCount(data.unpriced.tokens_in)} tokens in · {fmtCount(data.unpriced.tokens_out)} out</span>
            </div>
          )}

          <Budget current={mtd.budget_usd} onSaved={load} />
          <Prices prices={data.prices_per_1m || {}} />
        </>
      )}
    </section>
  );
}

function UsageSkeleton() {
  return (
    <div aria-hidden="true">
      <div className="bd-stats bd-usage-cards">
        {[0, 1, 2, 3, 4].map((i) => <div key={i} className="bd-stat"><div className="bd-skel is-label" /><div className="bd-skel is-value" /></div>)}
      </div>
      <div className="bd-skel is-chart" />
    </div>
  );
}

function Tile({ label, value, sub, warn }) {
  return (
    <div className={`bd-stat ${warn ? 'is-warn' : ''}`}>
      <div className="bd-stat-label">{label}</div>
      <div className="bd-stat-value">{value}</div>
      {sub && <div className="bd-card-sub">{sub}</div>}
    </div>
  );
}

function DailyChart({ days }) {
  if (!days.length) return null;
  const rows = days.map((d) => ({ ...d, label: d.date.slice(5), cost: Number(d.est_cost_usd) || 0 }));
  return (
    <figure className="bd-usage-chart" aria-label="Daily cost">
      <ResponsiveContainer width="100%" height={180}>
        <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--border-subtle)" />
          <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickLine={false} axisLine={{ stroke: 'var(--border-subtle)' }} minTickGap={12} />
          <YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickLine={false} axisLine={false} width={48} tickFormatter={(v) => fmtUsd(v)} />
          <Tooltip
            cursor={{ fill: 'var(--accent-soft)' }}
            contentStyle={{ background: 'var(--surface-1)', border: '1px solid var(--border-default)', borderRadius: 8, fontSize: 12, color: 'var(--text-primary)' }}
            labelFormatter={(_l, p) => p?.[0]?.payload?.date || ''}
            formatter={(v, _n, p) => [`${fmtUsd(v)} · ${fmtCount(p?.payload?.questions)} questions`, 'Cost']}
          />
          <Bar dataKey="cost" fill="var(--accent)" radius={[3, 3, 0, 0]} maxBarSize={22} />
        </BarChart>
      </ResponsiveContainer>
      <figcaption className="bd-card-sub">Estimated cost per day</figcaption>
    </figure>
  );
}

function UsageTable({ title, head, rows }) {
  return (
    <div className="bd-usage-table">
      <div className="bd-group-label">{title}</div>
      {rows.length === 0 ? <div className="bd-card-sub px-2">Nothing in this range.</div> : (
        <div className="table-responsive">
          <table className="table table-sm mb-0">
            <thead><tr>{head.map((h, i) => <th key={h} className={i > 0 ? 'text-end' : ''} scope="col">{h}</th>)}</tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>{r.map((c, j) => <td key={j} className={j > 0 ? 'text-end' : 'text-truncate'}>{c}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Budget({ current, onSaved }) {
  const [value, setValue] = useState(current != null ? String(current) : '');
  const [msg, setMsg] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { setValue(current != null ? String(current) : ''); }, [current]);

  const save = async (e) => {
    e.preventDefault();
    const v = value.trim() === '' ? null : Number(value);
    if (v != null && (!Number.isFinite(v) || v < 0)) { setMsg('Enter a positive amount, or leave it empty for no budget.'); return; }
    setSaving(true); setMsg('');
    try { await setMonthlyBudget(v); setMsg('Saved.'); onSaved(); }
    catch (ex) { setMsg(`Couldn't save: ${ex.message}`); }
    finally { setSaving(false); }
  };

  return (
    <form className="bd-usage-budget" onSubmit={save}>
      <label className="form-label small fw-semibold mb-1" htmlFor="bd-budget">Monthly budget (USD)</label>
      <div className="d-flex align-items-center gap-2 flex-wrap">
        <input id="bd-budget" type="number" min="0" step="0.01" inputMode="decimal" className="form-control form-control-sm"
          style={{ maxWidth: 160 }} placeholder="No budget" value={value} onChange={(e) => setValue(e.target.value)} />
        <button type="submit" className="btn btn-sm btn-outline-secondary" disabled={saving}>
          {saving ? <span className="spinner-border spinner-border-sm" /> : 'Save budget'}
        </button>
        {msg && <span className="small" role="status">{msg}</span>}
      </div>
      <div className="bd-card-sub mt-1">For reporting only. Buddy is never blocked by the budget.</div>
    </form>
  );
}

function Prices({ prices }) {
  const rows = Object.entries(prices);
  if (!rows.length) return null;
  return (
    <details className="bd-usage-prices">
      <summary className="small fw-semibold">Prices used (USD per 1M tokens)</summary>
      <div className="table-responsive">
        <table className="table table-sm mb-1">
          <thead><tr><th scope="col">Model</th><th scope="col" className="text-end">Input</th><th scope="col" className="text-end">Cached input</th><th scope="col" className="text-end">Output</th></tr></thead>
          <tbody>
            {rows.map(([model, p]) => (
              <tr key={model}><td>{model}</td><td className="text-end">{fmtUsd(p?.in)}</td><td className="text-end">{fmtUsd(p?.cached)}</td><td className="text-end">{fmtUsd(p?.out)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="bd-card-sub">
        These are estimates; the OpenAI dashboard is the exact bill:{' '}
        <a href="https://platform.openai.com/usage" target="_blank" rel="noopener noreferrer">platform.openai.com/usage</a>.
      </div>
    </details>
  );
}
