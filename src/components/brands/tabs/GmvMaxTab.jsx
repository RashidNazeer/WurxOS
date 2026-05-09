import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../../contexts/AuthContext';
import {
  GMV_MAX_FIELDS, GMV_CAMPAIGN_META_FIELDS, CAMPAIGN_STATUSES,
  formatGmvField, getGmvMaxReportsForBrand,
  saveGmvMaxReport, setGmvMaxCampaigns, deleteGmvMaxReport,
  monthRange, monthLabel, newCampaignId,
} from '../../../lib/gmvMaxApi';
import {
  PlusIcon, PencilIcon, TrashIcon, CheckIcon, XIcon, AlertIcon,
} from '../../common/Icon';

// ── Field icons / tints ────────────────────────────────────────────
function fieldEmoji(k) {
  return ({ cost: '💰', skuOrders: '📦', costPerOrder: '🧾', grossRevenue: '📈', roi: '⭐' })[k] || '•';
}
function fieldTint(k) {
  return ({ cost: '#0ea5e9', skuOrders: '#16a34a', costPerOrder: '#8b5cf6', grossRevenue: '#d97706', roi: '#ec4899' })[k] || '#64748b';
}
function statusCfg(key) {
  return CAMPAIGN_STATUSES.find(s => s.key === key) || CAMPAIGN_STATUSES[0];
}

// ── Reusable metric tile ───────────────────────────────────────────
function MetricTile({ field, value }) {
  const tint = fieldTint(field.key);
  const has = value !== '' && value != null;
  return (
    <div style={{
      flex: '1 1 calc(20% - 10px)', minWidth: 140,
      background: has ? `linear-gradient(135deg, ${tint}10, ${tint}03)` : 'var(--surface-2)',
      border: `1px solid ${has ? tint + '22' : 'var(--border)'}`,
      borderRadius: 12, padding: '12px 14px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{
          width: 24, height: 24, borderRadius: 6,
          background: has ? tint + '1f' : 'var(--surface-3, #e2e8f0)',
          color: has ? tint : 'var(--text-muted)',
          display: 'grid', placeItems: 'center', fontSize: 11,
        }}>{fieldEmoji(field.key)}</div>
        {field.suffix && (
          <span style={{
            fontSize: 8.5, fontWeight: 700,
            color: has ? tint : 'var(--text-muted)',
            background: has ? tint + '15' : 'var(--surface-2)',
            padding: '2px 7px', borderRadius: 999,
            letterSpacing: '0.06em', textTransform: 'uppercase',
          }}>{field.suffix}</span>
        )}
      </div>
      <div style={{
        fontSize: 9.5, fontWeight: 700, color: 'var(--text-muted)',
        textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 2,
      }}>{field.label}</div>
      <div style={{
        fontSize: 17, fontWeight: 800,
        color: has ? 'var(--text-primary)' : 'var(--text-muted)',
        letterSpacing: '-0.02em', lineHeight: 1.15,
      }}>
        {has ? formatGmvField(field.key, value) : '—'}
      </div>
    </div>
  );
}

// ── Modal shell ────────────────────────────────────────────────────
function ModalShell({ onClose, title, subtitle, children }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1070,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(15,23,42,0.5)', backdropFilter: 'blur(3px)' }} onClick={onClose} />
      <div className="wx-card" style={{
        position: 'relative', width: '100%', maxWidth: 720, zIndex: 1, borderRadius: 18,
        maxHeight: '92vh', display: 'flex', flexDirection: 'column', padding: 0,
        overflow: 'hidden',
      }}>
        {/* Header — fixed top with title + close button */}
        <div style={{
          padding: '16px 22px',
          borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'flex-start', gap: 12,
          flexShrink: 0, background: 'var(--surface-1)',
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h6 style={{ fontWeight: 800, margin: '0 0 4px', letterSpacing: '-0.01em', fontSize: 15, color: 'var(--text-primary)' }}>{title}</h6>
            {subtitle && <p style={{ color: 'var(--text-muted)', fontSize: 12.5, margin: 0, lineHeight: 1.4 }}>{subtitle}</p>}
          </div>
          <button
            type="button" onClick={onClose} aria-label="Close" title="Close"
            style={{
              width: 32, height: 32, flexShrink: 0,
              borderRadius: 8, border: '1px solid var(--border)',
              background: 'var(--surface-1)', color: 'var(--text-secondary)',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', padding: 0, transition: 'background 120ms ease, color 120ms ease',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-2)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--surface-1)'; e.currentTarget.style.color = 'var(--text-secondary)'; }}>
            <XIcon width="16" height="16" />
          </button>
        </div>
        {/* Scrollable body */}
        <div style={{ padding: '14px 22px', flexGrow: 1, overflowY: 'auto', minHeight: 0 }}>
          {children}
        </div>
      </div>
    </div>
  );
}

function ModalFooter({ onClose, saving, canSave, onSave }) {
  return (
    <div style={{
      marginTop: 18,
      marginInline: -22, marginBottom: -14,
      padding: '14px 22px',
      display: 'flex', gap: 8, justifyContent: 'flex-end',
      borderTop: '1px solid var(--border)',
      background: 'var(--surface-1)',
      position: 'sticky', bottom: -14,
    }}>
      <button className="wx-btn wx-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
      <button className="wx-btn wx-btn-primary" onClick={onSave} disabled={saving || !canSave}>
        {saving ? <><span className="wx-spinner" /> Saving…</> : <><CheckIcon width="14" height="14" /> Save</>}
      </button>
    </div>
  );
}

function SectionHeading({ emoji, title, tint }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, marginTop: 14 }}>
      <div style={{
        width: 28, height: 28, borderRadius: 6, background: tint + '1f', color: tint,
        display: 'grid', placeItems: 'center', fontSize: 13,
      }}>{emoji}</div>
      <h6 style={{ fontWeight: 800, margin: 0, fontSize: 13, color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>{title}</h6>
    </div>
  );
}

// ── Overview edit modal ────────────────────────────────────────────
function OverviewEditModal({ brand, defaultValues, onClose, onSaved }) {
  const [periodStart, setPeriodStart] = useState(defaultValues?.periodStart || '');
  const [periodEnd, setPeriodEnd] = useState(defaultValues?.periodEnd || '');
  const [periodLabel, setPeriodLabel] = useState(defaultValues?.periodLabel || '');
  const [cost, setCost] = useState(defaultValues?.cost ?? '');
  const [skuOrders, setSkuOrders] = useState(defaultValues?.skuOrders ?? '');
  const [costPerOrder, setCostPerOrder] = useState(defaultValues?.costPerOrder ?? '');
  const [grossRevenue, setGrossRevenue] = useState(defaultValues?.grossRevenue ?? '');
  const [roi, setRoi] = useState(defaultValues?.roi ?? '');
  const [notes, setNotes] = useState(defaultValues?.notes || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const today = new Date();
  const [year, setYear] = useState(defaultValues ? new Date(defaultValues.periodStart).getFullYear() : today.getFullYear());
  const [monthIdx, setMonthIdx] = useState(defaultValues ? new Date(defaultValues.periodStart).getMonth() : today.getMonth());

  useEffect(() => {
    if (defaultValues) return;
    const r = monthRange(year, monthIdx);
    setPeriodStart(r.start);
    setPeriodEnd(r.end);
    setPeriodLabel(monthLabel(year, monthIdx));
  }, [year, monthIdx, defaultValues]);

  async function handleSave() {
    if (!periodStart || !periodEnd) { setError('Pick a month.'); return; }
    setSaving(true); setError('');
    try {
      await saveGmvMaxReport({
        brandId: brand.id,
        brandName: brand.brand_name || '',
        period: 'monthly', periodStart, periodEnd, periodLabel,
        cost, skuOrders, costPerOrder, grossRevenue, roi, notes,
      });
      onSaved();
    } catch (e) {
      setError(e?.message || 'Failed to save.');
    } finally { setSaving(false); }
  }

  return (
    <ModalShell onClose={onClose}
      title={`${defaultValues ? 'Edit' : 'Add'} Monthly Overview — ${brand.brand_name}`}
      subtitle="Paste the 5 metrics shown in TikTok Ads Manager / Seller Center.">
      {!defaultValues && (
        <div style={{ marginBottom: 14, padding: 12, borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
            <label style={{ fontSize: 12, fontWeight: 700, margin: 0 }}>Month</label>
            <select className="wx-input" style={{ width: 'auto', padding: '4px 8px', fontSize: 12.5 }}
              value={year} onChange={e => setYear(Number(e.target.value))}>
              {[today.getFullYear() - 1, today.getFullYear(), today.getFullYear() + 1].map(y => <option key={y} value={y}>{y}</option>)}
            </select>
            <select className="wx-input" style={{ width: 'auto', padding: '4px 8px', fontSize: 12.5 }}
              value={monthIdx} onChange={e => setMonthIdx(Number(e.target.value))}>
              {Array.from({ length: 12 }, (_, i) => (
                <option key={i} value={i}>{new Date(2000, i, 1).toLocaleString('en-US', { month: 'long' })}</option>
              ))}
            </select>
          </div>
          {periodLabel && (
            <div style={{ color: 'var(--text-muted)', fontSize: 11.5 }}>
              Selected: <strong style={{ color: 'var(--text-primary)' }}>{periodLabel}</strong> ({periodStart} → {periodEnd})
            </div>
          )}
        </div>
      )}
      {defaultValues && (
        <div style={{ marginBottom: 14, padding: 8, borderRadius: 8, background: '#eff6ff', border: '1px solid #bfdbfe' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#1e40af' }}>{periodLabel}</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>{periodStart} → {periodEnd}</div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
        {[
          ['cost', cost, setCost],
          ['skuOrders', skuOrders, setSkuOrders],
          ['costPerOrder', costPerOrder, setCostPerOrder],
          ['grossRevenue', grossRevenue, setGrossRevenue],
          ['roi', roi, setRoi],
        ].map(([key, val, setter]) => {
          const f = GMV_MAX_FIELDS.find(x => x.key === key);
          return (
            <div key={key}>
              <label style={{ fontSize: 12, fontWeight: 700, marginBottom: 4, display: 'block' }}>
                {f.label} {f.suffix && <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>({f.suffix})</span>}
              </label>
              <input type="number" step="any" className="wx-input"
                placeholder={f.hint} value={val} onChange={e => setter(e.target.value)} />
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 12 }}>
        <label style={{ fontSize: 12, fontWeight: 700, marginBottom: 4, display: 'block' }}>Notes (optional)</label>
        <textarea className="wx-input" rows={2}
          placeholder="Any additional context for this month…"
          value={notes} onChange={e => setNotes(e.target.value)} />
      </div>

      {error && (
        <div className="wx-alert wx-alert-danger" style={{ marginTop: 12 }}>
          <AlertIcon width="14" height="14" /> <span>{error}</span>
        </div>
      )}

      <ModalFooter onClose={onClose} saving={saving} canSave={!!periodStart} onSave={handleSave} />
    </ModalShell>
  );
}

// ── Campaign edit modal ────────────────────────────────────────────
function CampaignEditModal({ brand, monthlyDoc, defaultValues, onClose, onSaved }) {
  const [c, setC] = useState({
    id:           defaultValues?.id || newCampaignId(),
    campaignName: defaultValues?.campaignName || '',
    campaignId:   defaultValues?.campaignId || '',
    targetRoi:    defaultValues?.targetRoi ?? '',
    scheduleTime: defaultValues?.scheduleTime || '',
    campaignBudget: defaultValues?.campaignBudget ?? '',
    status:       defaultValues?.status || 'active',
    cost:         defaultValues?.cost ?? '',
    skuOrders:    defaultValues?.skuOrders ?? '',
    costPerOrder: defaultValues?.costPerOrder ?? '',
    grossRevenue: defaultValues?.grossRevenue ?? '',
    roi:          defaultValues?.roi ?? '',
    notes:        defaultValues?.notes || '',
  });
  const upd = (k, v) => setC(prev => ({ ...prev, [k]: v }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSave() {
    if (!c.campaignName.trim()) { setError('Campaign name is required.'); return; }
    setSaving(true); setError('');
    try {
      const existing = monthlyDoc?.campaigns || [];
      const next = defaultValues
        ? existing.map(x => x.id === c.id ? c : x)
        : [...existing, c];
      await setGmvMaxCampaigns({
        brandId: brand.id, brandName: brand.brand_name || '',
        periodStart: monthlyDoc.periodStart, periodEnd: monthlyDoc.periodEnd, periodLabel: monthlyDoc.periodLabel,
        campaigns: next,
      });
      onSaved();
    } catch (e) {
      setError(e?.message || 'Failed to save.');
    } finally { setSaving(false); }
  }

  const stCfg = statusCfg(c.status);

  return (
    <ModalShell onClose={onClose}
      title={`${defaultValues ? 'Edit' : 'Add'} Campaign — ${brand.brand_name}`}
      subtitle={`For ${monthlyDoc.periodLabel}. Fill in the campaign metadata and its actual performance.`}>

      <SectionHeading emoji="📣" title="Campaign details" tint="#0ea5e9" />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, marginBottom: 14 }}>
        {GMV_CAMPAIGN_META_FIELDS.map(f => (
          <div key={f.key} style={{ gridColumn: f.key === 'campaignName' ? '1 / -1' : 'auto' }}>
            <label style={{ fontSize: 12, fontWeight: 700, marginBottom: 4, display: 'block' }}>
              {f.label}
              {f.required && <span style={{ color: '#dc2626', marginLeft: 3 }}>*</span>}
              {f.suffix && <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> ({f.suffix})</span>}
            </label>
            <input type={f.type} step={f.type === 'number' ? 'any' : undefined}
              className="wx-input" placeholder={f.placeholder}
              value={c[f.key]} onChange={e => upd(f.key, e.target.value)} />
          </div>
        ))}
        <div style={{ gridColumn: '1 / -1' }}>
          <label style={{ fontSize: 12, fontWeight: 700, marginBottom: 4, display: 'block' }}>Status</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {CAMPAIGN_STATUSES.map(s => {
              const active = c.status === s.key;
              return (
                <button key={s.key} type="button"
                  onClick={() => upd('status', s.key)}
                  style={{
                    borderRadius: 999, padding: '5px 14px',
                    background: active ? s.color : s.bg,
                    color: active ? '#fff' : s.color,
                    border: `1.5px solid ${active ? s.color : s.color + '40'}`,
                    fontSize: 12, fontWeight: 600,
                    display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer',
                  }}>
                  {active && <CheckIcon width="11" height="11" />}
                  {s.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <SectionHeading emoji="📊" title="Actual performance" tint="#16a34a" />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, marginBottom: 14 }}>
        {GMV_MAX_FIELDS.map(f => (
          <div key={f.key}>
            <label style={{ fontSize: 12, fontWeight: 700, marginBottom: 4, display: 'block' }}>
              {f.label} {f.suffix && <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>({f.suffix})</span>}
            </label>
            <input type="number" step="any" className="wx-input"
              placeholder={f.hint} value={c[f.key]} onChange={e => upd(f.key, e.target.value)} />
          </div>
        ))}
      </div>

      <div>
        <label style={{ fontSize: 12, fontWeight: 700, marginBottom: 4, display: 'block' }}>Notes (optional)</label>
        <textarea className="wx-input" rows={2}
          placeholder="Any additional context for this campaign…"
          value={c.notes} onChange={e => upd('notes', e.target.value)} />
      </div>

      <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
        <span style={{ color: 'var(--text-muted)' }}>Status preview:</span>
        <span style={{
          background: stCfg.bg, color: stCfg.color, fontSize: 11, padding: '4px 10px',
          borderRadius: 999, fontWeight: 700,
        }}>{stCfg.label}</span>
      </div>

      {error && (
        <div className="wx-alert wx-alert-danger" style={{ marginTop: 12 }}>
          <AlertIcon width="14" height="14" /> <span>{error}</span>
        </div>
      )}

      <ModalFooter onClose={onClose} saving={saving} canSave={!!c.campaignName.trim()} onSave={handleSave} />
    </ModalShell>
  );
}

// ── Campaign card ──────────────────────────────────────────────────
function MetaPill({ label, value, tint = '#64748b' }) {
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, borderRadius: 999,
      background: tint + '14', color: tint,
      padding: '3px 10px', fontSize: 11, fontWeight: 600,
    }}>
      <span style={{ opacity: 0.7, fontWeight: 500 }}>{label}</span>
      <span style={{ color: 'var(--text-primary)', fontWeight: 700 }}>{value}</span>
    </div>
  );
}

function formatScheduleTime(s) {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function CampaignCard({ campaign, onEdit, onRemove }) {
  const st = statusCfg(campaign.status);
  return (
    <div style={{
      background: 'var(--surface-1, #fff)',
      borderRadius: 14, border: '1px solid var(--border)',
      padding: 16, boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <div style={{ minWidth: 0, flex: '1 1 auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <h6 style={{ fontWeight: 800, margin: 0, fontSize: 15, color: 'var(--text-primary)', letterSpacing: '-0.015em' }}>
              {campaign.campaignName || 'Untitled Campaign'}
            </h6>
            <span style={{
              background: st.bg, color: st.color, fontSize: 10, padding: '4px 10px', fontWeight: 700,
              borderRadius: 999, display: 'inline-flex', alignItems: 'center', gap: 4,
            }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: st.color }} />
              {st.label}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
            {campaign.campaignId && <MetaPill label="ID" value={campaign.campaignId} />}
            {campaign.targetRoi != null && campaign.targetRoi !== '' && Number(campaign.targetRoi) !== 0 && (
              <MetaPill label="Target ROI" value={`${Number(campaign.targetRoi).toFixed(2)}x`} tint="#ec4899" />
            )}
            {campaign.scheduleTime && (
              <MetaPill label="Scheduled" value={formatScheduleTime(campaign.scheduleTime)} tint="#0ea5e9" />
            )}
            {campaign.campaignBudget != null && campaign.campaignBudget !== '' && Number(campaign.campaignBudget) !== 0 && (
              <MetaPill label="Budget" value={Number(campaign.campaignBudget).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })} tint="#16a34a" />
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
          <button className="wx-btn wx-btn-ghost" style={{ padding: '4px 10px', fontSize: 12 }} onClick={onEdit}>
            <PencilIcon width="12" height="12" /> Edit
          </button>
          <button className="wx-btn wx-btn-ghost" style={{ padding: '4px 10px', fontSize: 12, color: 'var(--danger)' }} onClick={onRemove}>
            <TrashIcon width="12" height="12" />
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {GMV_MAX_FIELDS.map(f => <MetricTile key={f.key} field={f} value={campaign[f.key]} />)}
      </div>

      {campaign.notes && (
        <div style={{ marginTop: 12, padding: 8, borderRadius: 8, background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{campaign.notes}</div>
        </div>
      )}
    </div>
  );
}

// ── Monthly block ─────────────────────────────────────────────────
function MonthlyBlock({ brand, monthlyDoc, onChange, onDelete, canEdit }) {
  const [editingOverview, setEditingOverview] = useState(false);
  const [editingCampaign, setEditingCampaign] = useState(null);
  const [busy, setBusy] = useState(false);

  const overviewHasData = ['cost','skuOrders','costPerOrder','grossRevenue','roi'].some(k =>
    monthlyDoc[k] != null && monthlyDoc[k] !== '' && Number(monthlyDoc[k]) !== 0
  );
  const campaigns = monthlyDoc.campaigns || [];

  async function handleRemoveCampaign(cmp) {
    if (!window.confirm(`Remove campaign "${cmp.campaignName || 'Untitled'}"?`)) return;
    setBusy(true);
    try {
      const next = campaigns.filter(x => x.id !== cmp.id);
      await setGmvMaxCampaigns({
        brandId: brand.id, brandName: brand.brand_name || '',
        periodStart: monthlyDoc.periodStart, periodEnd: monthlyDoc.periodEnd, periodLabel: monthlyDoc.periodLabel,
        campaigns: next,
      });
      onChange();
    } finally { setBusy(false); }
  }

  return (
    <div style={{ marginBottom: 22, position: 'relative' }}>
      {/* Month header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <div style={{
          width: 44, height: 44, borderRadius: 10,
          background: 'linear-gradient(135deg, #0ea5e9, #0369a1)', color: '#fff',
          display: 'grid', placeItems: 'center', fontSize: 18,
          boxShadow: '0 4px 12px rgba(14,165,233,0.4)',
        }}>📅</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h5 style={{ fontWeight: 800, margin: 0, color: 'var(--text-primary)', letterSpacing: '-0.02em', fontSize: 16 }}>{monthlyDoc.periodLabel}</h5>
          <div style={{ color: 'var(--text-muted)', fontSize: 11.5 }}>
            {monthlyDoc.periodStart} → {monthlyDoc.periodEnd}
            {monthlyDoc.updatedByName && ` · last updated by ${monthlyDoc.updatedByName}`}
          </div>
        </div>
        {canEdit && (
          <button className="wx-btn wx-btn-ghost" style={{ padding: '4px 10px', fontSize: 12, color: 'var(--danger)' }}
            onClick={onDelete} title="Delete this month">
            <TrashIcon width="12" height="12" />
          </button>
        )}
      </div>

      {/* Overview card */}
      <div style={{
        background: 'linear-gradient(135deg, var(--surface-1, #fff), var(--surface-2))',
        borderRadius: 16, border: '1px solid var(--border)',
        padding: 18, boxShadow: '0 4px 14px rgba(15,23,42,0.04)', marginBottom: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 30, height: 30, borderRadius: 6, background: '#0ea5e91f', color: '#0ea5e9', display: 'grid', placeItems: 'center', fontSize: 14 }}>📊</div>
            <div>
              <h6 style={{ margin: 0, fontWeight: 800, fontSize: 14, letterSpacing: '-0.01em' }}>Monthly Overview</h6>
              <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>Aggregate GMV Max metrics across all campaigns this month.</div>
            </div>
          </div>
          {canEdit && (
            <button className="wx-btn wx-btn-ghost" style={{ padding: '4px 10px', fontSize: 12 }}
              onClick={() => setEditingOverview(true)}>
              <PencilIcon width="12" height="12" /> {overviewHasData ? 'Edit' : 'Add'} Overview
            </button>
          )}
        </div>

        {overviewHasData ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {GMV_MAX_FIELDS.map(f => <MetricTile key={f.key} field={f} value={monthlyDoc[f.key]} />)}
          </div>
        ) : (
          <div style={{ textAlign: 'center', padding: 14, borderRadius: 10, background: 'var(--surface-2)', border: '1px dashed var(--border)' }}>
            <div style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>No overview metrics yet — click "Add Overview" to enter the 5 main GMV Max numbers.</div>
          </div>
        )}

        {monthlyDoc.notes && (
          <div style={{ marginTop: 12, padding: 8, borderRadius: 8, background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{monthlyDoc.notes}</div>
          </div>
        )}
      </div>

      {/* Campaigns card */}
      <div style={{
        background: 'linear-gradient(135deg, var(--surface-1, #fff), var(--surface-2))',
        borderRadius: 16, border: '1px solid var(--border)',
        padding: 18, boxShadow: '0 4px 14px rgba(15,23,42,0.04)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 30, height: 30, borderRadius: 6, background: '#16a34a1f', color: '#16a34a', display: 'grid', placeItems: 'center', fontSize: 14 }}>📣</div>
            <div>
              <h6 style={{ margin: 0, fontWeight: 800, fontSize: 14, letterSpacing: '-0.01em', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                Campaigns
                {campaigns.length > 0 && (
                  <span style={{ background: '#16a34a15', color: '#16a34a', fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 999 }}>
                    {campaigns.length}
                  </span>
                )}
              </h6>
              <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>Per-campaign performance plus campaign metadata (ID, target ROI, schedule, budget).</div>
            </div>
          </div>
          {canEdit && (
            <button className="wx-btn wx-btn-primary" style={{ padding: '4px 12px', fontSize: 12 }}
              onClick={() => setEditingCampaign({ defaultValues: null })}>
              <PlusIcon width="12" height="12" /> Add Campaign
            </button>
          )}
        </div>

        {campaigns.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 22, borderRadius: 10, background: 'var(--surface-2)', border: '1px dashed var(--border)' }}>
            <div style={{ fontSize: 22, opacity: 0.4 }}>📣</div>
            <div style={{ marginTop: 6, fontWeight: 700, fontSize: 13, color: 'var(--text-secondary)' }}>No campaigns added yet</div>
            <div style={{ color: 'var(--text-muted)', fontSize: 11.5 }}>Click "Add Campaign" to enter campaign-level data for this month.</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {campaigns.map(c => (
              <CampaignCard key={c.id} campaign={c}
                onEdit={() => canEdit && setEditingCampaign({ defaultValues: c })}
                onRemove={() => canEdit && handleRemoveCampaign(c)} />
            ))}
          </div>
        )}
      </div>

      {editingOverview && (
        <OverviewEditModal brand={brand} defaultValues={monthlyDoc}
          onClose={() => setEditingOverview(false)}
          onSaved={() => { setEditingOverview(false); onChange(); }} />
      )}
      {editingCampaign && (
        <CampaignEditModal brand={brand} monthlyDoc={monthlyDoc}
          defaultValues={editingCampaign.defaultValues}
          onClose={() => setEditingCampaign(null)}
          onSaved={() => { setEditingCampaign(null); onChange(); }} />
      )}
      {busy && (
        <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 8 }}>
          <span className="wx-spinner" /> Updating…
        </div>
      )}
    </div>
  );
}

// ── Tab root ──────────────────────────────────────────────────────
// `canCreate` defaults to true. Brand Detail passes false when the
// brand is inactive so the entry UI is read-only.
export default function GmvMaxTab({ brand, canCreate = true }) {
  const { profile } = useAuth();
  const role = profile?.role;
  // Boss/OL/TL/PCTL/APC/IPC/Developer can write per RLS — but only
  // when the brand itself accepts new entries.
  const canEdit = canCreate && ['boss','ol','tl','pctl','apc','ipc','developer'].includes(role);

  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [addingMonth, setAddingMonth] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const refresh = useCallback(async () => {
    if (!brand?.id) return;
    setLoading(true);
    try {
      const list = await getGmvMaxReportsForBrand(brand.id, 'monthly');
      setReports(list);
    } finally { setLoading(false); }
  }, [brand?.id]);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleDeleteMonth(r) {
    setDeleteTarget(null);
    await deleteGmvMaxReport(r.id);
    setReports(prev => prev.filter(x => x.id !== r.id));
  }

  if (!brand) return null;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h5 style={{ fontWeight: 800, margin: '0 0 4px', color: 'var(--text-primary)', letterSpacing: '-0.02em', fontSize: 16, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: '#0ea5e9' }}>📊</span>
            GMV Max Reporting
          </h5>
          <p style={{ color: 'var(--text-muted)', fontSize: 12.5, margin: 0 }}>
            Monthly Overview plus per-campaign performance for {brand.brand_name}.
          </p>
        </div>
        {canEdit && (
          <button className="wx-btn wx-btn-primary" onClick={() => setAddingMonth(true)}>
            <PlusIcon width="14" height="14" /> Add Month
          </button>
        )}
      </div>

      {loading ? (
        <div className="wx-empty"><span className="wx-spinner" /> Loading…</div>
      ) : reports.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 36, border: '2px dashed var(--border)', borderRadius: 16, background: 'var(--surface-2)' }}>
          <div style={{ fontSize: 38, opacity: 0.4 }}>📊</div>
          <h6 style={{ fontWeight: 800, marginTop: 14, marginBottom: 4, color: 'var(--text-secondary)' }}>No GMV Max data yet</h6>
          <p style={{ color: 'var(--text-muted)', fontSize: 12.5, margin: 0 }}>
            {canEdit ? 'Click "Add Month" to start entering monthly overview metrics and campaigns.' : 'No data has been entered yet.'}
          </p>
        </div>
      ) : (
        reports.map(r => (
          <MonthlyBlock key={r.id} brand={brand} monthlyDoc={r}
            onChange={refresh}
            onDelete={() => setDeleteTarget(r)}
            canEdit={canEdit} />
        ))
      )}

      {addingMonth && (
        <OverviewEditModal brand={brand} defaultValues={null}
          onClose={() => setAddingMonth(false)}
          onSaved={() => { setAddingMonth(false); refresh(); }} />
      )}

      {deleteTarget && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1080, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(15,23,42,0.5)' }} onClick={() => setDeleteTarget(null)} />
          <div className="wx-card" style={{ position: 'relative', maxWidth: 420, padding: 22, textAlign: 'center' }}>
            <div style={{ fontSize: 30, color: '#dc2626' }}>⚠️</div>
            <h6 style={{ fontWeight: 800, marginTop: 8, marginBottom: 6 }}>Delete this month?</h6>
            <p style={{ color: 'var(--text-muted)', fontSize: 12.5, margin: '0 0 14px' }}>
              {deleteTarget.periodLabel} — overview and {(deleteTarget.campaigns || []).length} campaign{(deleteTarget.campaigns || []).length !== 1 ? 's' : ''} will be permanently removed.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              <button className="wx-btn wx-btn-ghost" onClick={() => setDeleteTarget(null)}>Cancel</button>
              <button className="wx-btn wx-btn-primary" style={{ background: '#dc2626' }} onClick={() => handleDeleteMonth(deleteTarget)}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
