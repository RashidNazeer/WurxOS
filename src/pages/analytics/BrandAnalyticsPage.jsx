import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import BrandAvatar from '../../components/brands/BrandAvatar';
import { AlertIcon } from '../../components/common/Icon';
import {
  listActiveBrands, getBrandMonthlyMetrics, saveBrandMonthlyMetrics, listMonthsWithData,
} from '../../lib/brandMetricsApi';

// ── The 5 metrics (each a target/achieved pair) ─────────────────────
const METRICS = [
  { key: 'gmv',        label: 'Monthly GMV Goal',   unit: '$', tCol: 'gmv_target',            aCol: 'gmv_achieved',      tLabel: 'Goal',      aLabel: 'Achieved',  higherBetter: true,  icon: 'bi-graph-up-arrow', tint: '#0ea5e9' },
  { key: 'samples',    label: 'Sample Approvals',   unit: '#', tCol: 'samples_target',        aCol: 'samples_achieved',  tLabel: 'Goal',      aLabel: 'Approved',  higherBetter: true,  icon: 'bi-box-seam',       tint: '#16a34a' },
  { key: 'paidCollab', label: 'Paid Collab Budget', unit: '$', tCol: 'paid_collab_allocated', aCol: 'paid_collab_used',  tLabel: 'Allocated', aLabel: 'Used',      higherBetter: false, icon: 'bi-people-fill',    tint: '#8b5cf6' },
  { key: 'gmvMax',     label: 'GMV Max Budget',     unit: '$', tCol: 'gmv_max_allocated',     aCol: 'gmv_max_used',      tLabel: 'Allocated', aLabel: 'Utilized',  higherBetter: false, icon: 'bi-rocket-takeoff', tint: '#d97706' },
  { key: 'roi',        label: 'Target ROI',         unit: 'x', tCol: 'roi_target',            aCol: 'roi_achieved',      tLabel: 'Target',    aLabel: 'Actual',    higherBetter: true,  icon: 'bi-star-fill',      tint: '#ec4899' },
];

// ── month helpers ───────────────────────────────────────────────────
function pakistanMonth() {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  return ymd.slice(0, 7); // 'YYYY-MM'
}
function addMonths(monthKey, n) {
  const [y, m] = monthKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
}
function prettyMonth(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' });
}

// ── value formatting ────────────────────────────────────────────────
function fmt(unit, v) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  if (unit === '$') return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (unit === 'x') return n.toFixed(2) + 'x';
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}
// achieved ÷ target %, or null when there's no usable target.
function pctOf(target, achieved) {
  const t = Number(target);
  if (!t || t <= 0) return null;
  return (Number(achieved) || 0) / t * 100;
}

export default function BrandAnalyticsPage() {
  const qc = useQueryClient();
  const [brandId, setBrandId] = useState('');
  const [month, setMonth] = useState(pakistanMonth);
  const [editing, setEditing] = useState(false);

  const { data: brands = [], isLoading: brandsLoading, error: brandsErr } = useQuery({
    queryKey: ['brandMetrics', 'brands'],
    queryFn: listActiveBrands,
  });
  // Auto-select the first brand so the page isn't empty on load.
  useEffect(() => {
    if (!brandId && brands.length) setBrandId(brands[0].id);
  }, [brands, brandId]);

  const selectedBrand = brands.find((b) => b.id === brandId) || null;

  const { data, isLoading, isError, isSuccess, error } = useQuery({
    queryKey: ['brandMetrics', brandId, month],
    queryFn: () => getBrandMonthlyMetrics(brandId, month),
    enabled: !!brandId,
  });
  const { data: monthsWithData = [] } = useQuery({
    queryKey: ['brandMetrics', 'months', brandId],
    queryFn: () => listMonthsWithData(brandId),
    enabled: !!brandId,
  });
  const hasAny = METRICS.some((m) => data && (data[m.tCol] != null || data[m.aCol] != null));

  const err = brandsErr?.message || error?.message || '';
  const thisMonth = pakistanMonth();

  return (
    <>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Brand analytics</h1>
          <p className="page-subtitle">Monthly goals and progress, per brand. Set a target and what was achieved for each.</p>
        </div>
        <button className="wx-btn wx-btn-primary" disabled={!brandId || !isSuccess} onClick={() => setEditing(true)}>
          <i className="bi bi-pencil-square me-1" /> {hasAny ? 'Edit goals' : 'Set goals'}
        </button>
      </div>

      {err && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 14 }}>
          <AlertIcon width="16" height="16" /> <span>{err}</span>
        </div>
      )}

      {/* Controls: brand picker + month navigator */}
      <div className="wx-card" style={{ padding: 14, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 240, flex: '1 1 240px' }}>
          {selectedBrand && <BrandAvatar brand={selectedBrand} size={38} radius={9} />}
          <select className="wx-input" value={brandId} onChange={(e) => setBrandId(e.target.value)}
            disabled={brandsLoading} style={{ flex: 1, minWidth: 0, fontWeight: 700 }}>
            {brandsLoading && <option>Loading…</option>}
            {!brandsLoading && brands.length === 0 && <option value="">No active brands</option>}
            {brands.map((b) => (<option key={b.id} value={b.id}>{b.brand_name}</option>))}
          </select>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
          <button className="wx-btn wx-btn-ghost" onClick={() => setMonth((m) => addMonths(m, -1))} title="Previous month"
            style={{ padding: '8px 11px' }}>
            <i className="bi bi-chevron-left" />
          </button>
          <div style={{ minWidth: 150, textAlign: 'center' }}>
            <div style={{ fontWeight: 800, fontSize: 15, color: 'var(--text-primary)' }}>{prettyMonth(month)}</div>
            <div style={{ fontSize: 10.5, color: 'var(--text-muted)', display: 'flex', gap: 6, justifyContent: 'center', alignItems: 'center' }}>
              {month === thisMonth ? 'This month' : (
                <button className="wx-btn-link" onClick={() => setMonth(thisMonth)}
                  style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent)', cursor: 'pointer', fontSize: 10.5 }}>
                  Jump to this month
                </button>
              )}
              {monthsWithData.includes(month) ? null : <span style={{ opacity: 0.6 }}>· no data</span>}
            </div>
          </div>
          <button className="wx-btn wx-btn-ghost" onClick={() => setMonth((m) => addMonths(m, 1))} title="Next month"
            style={{ padding: '8px 11px' }}>
            <i className="bi bi-chevron-right" />
          </button>
        </div>
      </div>

      {/* Metric cards */}
      {!brandId ? (
        <div className="wx-card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Pick a brand to see its goals.</div>
      ) : isLoading ? (
        <div className="wx-card" style={{ padding: 40, textAlign: 'center' }}><span className="wx-spinner" /> Loading…</div>
      ) : isError ? (
        // Never fall through to the "no goals" empty state on a failed read —
        // that would let an all-blank save wipe values that actually exist.
        <div className="wx-card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
          <AlertIcon width="18" height="18" /> <span style={{ marginLeft: 6 }}>Couldn't load this month's goals (maybe a connection blip). Use the month arrows to retry.</span>
        </div>
      ) : (
        <>
          {!hasAny && (
            <div className="wx-card" style={{ padding: '22px 20px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>No goals set for {prettyMonth(month)}</div>
                <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 2 }}>Set the targets and achieved values for {selectedBrand?.brand_name} this month.</div>
              </div>
              <button className="wx-btn wx-btn-primary" onClick={() => setEditing(true)}><i className="bi bi-plus-lg me-1" /> Set goals</button>
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14 }}>
            {METRICS.map((m) => (
              <MetricCard key={m.key} metric={m} target={data?.[m.tCol]} achieved={data?.[m.aCol]} />
            ))}
          </div>
          {data?.updated_at && (
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 12 }}>
              Last updated {new Date(data.updated_at).toLocaleString()}
            </div>
          )}
        </>
      )}

      {editing && (
        <EditModal
          brand={selectedBrand}
          month={month}
          data={data}
          onClose={() => setEditing(false)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['brandMetrics', brandId, month] });
            qc.invalidateQueries({ queryKey: ['brandMetrics', 'months', brandId] });
            setEditing(false);
          }}
        />
      )}
    </>
  );
}

// ── One metric card with a progress bar ─────────────────────────────
function MetricCard({ metric, target, achieved }) {
  const pct = pctOf(target, achieved);
  const over = pct != null && pct > 100;
  const met = pct != null && pct >= 100;
  const barColor = pct == null ? 'var(--border-default)'
    : (metric.higherBetter ? (met ? 'var(--success)' : metric.tint)
      : (over ? 'var(--danger)' : metric.tint));
  const pctText = pct == null ? '—' : `${pct.toFixed(0)}%`;

  return (
    <div className="wx-card" style={{ padding: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <div style={{ width: 34, height: 34, borderRadius: 9, flexShrink: 0, display: 'grid', placeItems: 'center',
          background: `${metric.tint}1f`, color: metric.tint }}>
          <i className={`bi ${metric.icon}`} style={{ fontSize: '1rem' }} />
        </div>
        <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>{metric.label}</div>
        <div style={{ marginLeft: 'auto', fontWeight: 800, fontSize: 18, fontVariantNumeric: 'tabular-nums',
          color: pct == null ? 'var(--text-muted)' : (over && !metric.higherBetter ? 'var(--danger)' : (met ? 'var(--success)' : 'var(--text-primary)')) }}>
          {pctText}
        </div>
      </div>

      <div style={{ height: 10, background: 'var(--surface-2)', borderRadius: 999, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct == null ? 0 : Math.min(pct, 100)}%`, background: barColor, borderRadius: 999, transition: 'width .3s' }} />
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12, gap: 12 }}>
        <div>
          <div style={{ fontSize: 10.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{metric.aLabel}</div>
          <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-primary)' }}>{fmt(metric.unit, achieved)}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 10.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{metric.tLabel}</div>
          <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-secondary)' }}>{fmt(metric.unit, target)}</div>
        </div>
      </div>
      {over && !metric.higherBetter && (
        <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 8 }}>
          <i className="bi bi-exclamation-triangle me-1" />Over budget
        </div>
      )}
    </div>
  );
}

// ── Edit modal (centered overlay) ───────────────────────────────────
function EditModal({ brand, month, data, onClose, onSaved }) {
  const [form, setForm] = useState(() => {
    const f = {};
    for (const m of METRICS) {
      f[m.tCol] = data?.[m.tCol] ?? '';
      f[m.aCol] = data?.[m.aCol] ?? '';
    }
    return f;
  });
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState('');
  const set = (col, v) => setForm((f) => ({ ...f, [col]: v }));

  async function save() {
    setSaving(true); setSaveErr('');
    try {
      await saveBrandMonthlyMetrics(brand.id, month, form);
      onSaved();
    } catch (e) {
      setSaveErr(e?.message || 'Could not save.');
      setSaving(false);
    }
  }

  const prefix = (unit) => (unit === '$' ? '$' : unit === 'x' ? '×' : '#');

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1070, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(15,23,42,0.5)', backdropFilter: 'blur(3px)' }} onClick={saving ? undefined : onClose} />
      <div className="wx-card" style={{ position: 'relative', width: '100%', maxWidth: 560, zIndex: 1, borderRadius: 18, maxHeight: '92vh', display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 12 }}>
          {brand && <BrandAvatar brand={brand} size={34} radius={8} />}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 15, color: 'var(--text-primary)' }}>{brand?.brand_name} goals</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{prettyMonth(month)}</div>
          </div>
          <button type="button" onClick={onClose} disabled={saving} aria-label="Close" className="wx-btn wx-btn-ghost" style={{ padding: '6px 10px' }}>
            <i className="bi bi-x-lg" />
          </button>
        </div>

        <div style={{ padding: '16px 22px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {METRICS.map((m) => (
            <div key={m.key}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <i className={`bi ${m.icon}`} style={{ color: m.tint }} />
                <span style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--text-primary)' }}>{m.label}</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <NumField label={m.tLabel} prefix={prefix(m.unit)} value={form[m.tCol]} onChange={(v) => set(m.tCol, v)} />
                <NumField label={m.aLabel} prefix={prefix(m.unit)} value={form[m.aCol]} onChange={(v) => set(m.aCol, v)} />
              </div>
            </div>
          ))}
          {saveErr && <div className="wx-alert wx-alert-danger" style={{ margin: 0 }}><AlertIcon width="15" height="15" /> {saveErr}</div>}
        </div>

        <div style={{ padding: '14px 22px', borderTop: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="wx-btn wx-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="wx-btn wx-btn-primary" onClick={save} disabled={saving}>
            {saving ? <><span className="wx-spinner" style={{ width: 14, height: 14 }} /> Saving…</> : 'Save goals'}
          </button>
        </div>
      </div>
    </div>
  );
}

function NumField({ label, prefix, value, onChange }) {
  return (
    <label style={{ display: 'block' }}>
      <span style={{ fontSize: 10.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</span>
      <div style={{ position: 'relative', marginTop: 4 }}>
        <span style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: 13, pointerEvents: 'none' }}>{prefix}</span>
        <input type="number" className="wx-input" inputMode="decimal" value={value}
          onChange={(e) => onChange(e.target.value)} placeholder="—"
          style={{ paddingLeft: 26, width: '100%' }} />
      </div>
    </label>
  );
}
