import { useEffect, useMemo, useState } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import {
  listCampaigns, createCampaign, deleteCampaign,
  listMyBrands, parsePastedPromotion, STATUS_META,
} from '../../lib/campaignsApi';
import { listProducts } from '../../lib/productsApi';
import BrandAvatar from '../../components/brands/BrandAvatar';
import {
  PlusIcon, AlertIcon, RefreshIcon, XIcon, CheckIcon, SearchIcon,
  BoxIcon, ClockIcon, TrashIcon, LinkIcon,
} from '../../components/common/Icon';
import '../../styles/table.css';
import '../../styles/modal.css';

const PROMO_TYPE_LABEL = {
  individual: 'Individual',
  cart:       'Cart-level',
  coupon:     'Coupon',
};

export default function ProductCampaignsPage() {
  const { profile } = useAuth();
  const role = profile?.role;
  const canWrite = ['boss','ol','developer','tl','pctl','apc','ipc'].includes(role);

  const [statusTab, setStatus]    = useState('all');
  const [q, setQ]                 = useState('');
  const [brandFilter, setBrand]   = useState('all');
  const [showCompose, setCompose] = useState(false);
  const [openRow, setOpen]        = useState(null);

  const qc = useQueryClient();
  const results = useQueries({
    queries: [
      { queryKey: ['product-campaigns', 'list', statusTab], queryFn: () => listCampaigns({ status: statusTab }) },
      { queryKey: ['product-campaigns', 'brands'],          queryFn: listMyBrands },
    ],
  });
  const [listQ, brandsQ] = results;
  const rows    = listQ.data || [];
  const brands  = brandsQ.data || [];
  const loading = listQ.isPending;
  const err     = results.find((r) => r.error)?.error?.message || '';
  const load    = () => qc.invalidateQueries({ queryKey: ['product-campaigns'] });

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (brandFilter !== 'all' && r.brand_id !== brandFilter) return false;
      if (qq && !(
        (r.product?.product_name || '').toLowerCase().includes(qq) ||
        (r.brand?.brand_name     || '').toLowerCase().includes(qq)
      )) return false;
      return true;
    });
  }, [rows, q, brandFilter]);

  return (
    <>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Product campaigns</h1>
          <p className="page-subtitle">Attach TikTok Shop promotions to an existing product on a brand.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="wx-btn wx-btn-ghost" onClick={load} title="Refresh"><RefreshIcon width="15" height="15" /></button>
          {canWrite && (
            <button className="wx-btn wx-btn-primary" onClick={() => setCompose(true)}>
              <PlusIcon width="15" height="15" /> New campaign
            </button>
          )}
        </div>
      </div>

      <div className="wx-toolbar">
        <div className="wx-search" style={{ flex: 1, minWidth: 240 }}>
          <span className="wx-search-icon"><SearchIcon width="16" height="16" /></span>
          <input className="wx-input" placeholder="Search product or brand…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="wx-input" style={{ maxWidth: 220 }} value={brandFilter} onChange={(e) => setBrand(e.target.value)}>
          <option value="all">All brands</option>
          {brands.map((b) => <option key={b.id} value={b.id}>{b.brand_name}</option>)}
        </select>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {['all','active','ending_soon','expired','draft'].map((s) => (
            <button key={s} type="button"
              className={`wx-role-chip ${statusTab === s ? 'wx-role-chip-active' : ''}`}
              onClick={() => setStatus(s)}>
              {s === 'all' ? 'All' : STATUS_META[s]?.label || s}
            </button>
          ))}
        </div>
      </div>

      {err && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 14 }}>
          <AlertIcon width="16" height="16" /> <span>{err}</span>
        </div>
      )}

      {loading ? (
        <div className="wx-empty"><span className="wx-spinner" /> Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="wx-empty">
          <div style={{ display: 'grid', placeItems: 'center', width: 52, height: 52, borderRadius: '50%', background: 'var(--surface-2)', color: 'var(--text-muted)', margin: '0 auto 12px' }}>
            <BoxIcon width="22" height="22" />
          </div>
          <div className="wx-empty-title">No campaigns in this view</div>
          <div>{canWrite ? 'Add the product from its brand first, then create a campaign here.' : 'Your brand campaigns will appear here.'}</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
          {filtered.map((r) => (
            <CampaignCard key={r.id} row={r} onClick={() => setOpen(r)} />
          ))}
        </div>
      )}

      {showCompose && (
        <ComposeStepModal
          brands={brands}
          onClose={() => setCompose(false)}
          onSaved={() => { setCompose(false); load(); }}
        />
      )}
      {openRow && (
        <CampaignDetailModal
          row={openRow}
          canWrite={canWrite}
          onClose={() => setOpen(null)}
          onChanged={load}
        />
      )}
    </>
  );
}

function CampaignCard({ row, onClick }) {
  const meta = STATUS_META[row._status] || STATUS_META.draft;
  const activePromos = (row.promotions || []).filter((p) => p.status !== 'expired').length;
  const totalPromos  = (row.promotions || []).length;

  return (
    <div className="wx-card" style={{ padding: 14, cursor: 'pointer' }} onClick={onClick}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <BrandAvatar brand={row.brand} size={38} radius={10} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 10.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {row.brand?.brand_name || '—'}
          </div>
          <div style={{ fontWeight: 700, fontSize: 14, marginTop: 2 }}>
            {row.product?.product_name || 'Unknown product'}
          </div>
        </div>
        <StatusBadge tone={meta.tone} label={meta.label} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 12 }}>
        <Stat label="Retail" value={`$${Number(row.product?.retail_price || 0).toFixed(2)}`} />
        <Stat label="Promotions" value={`${activePromos} / ${totalPromos}`} hint={totalPromos ? 'active / total' : 'none'} />
      </div>

      {row.latest_end_date && (
        <div style={{
          marginTop: 10, fontSize: 11.5, color: 'var(--text-muted)',
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <ClockIcon width="12" height="12" />
          {row._status === 'expired'
            ? <>Ended {fmtDate(row.latest_end_date)}</>
            : <>Ends {fmtDate(row.latest_end_date)}</>}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, hint }) {
  return (
    <div style={{
      padding: 9, background: 'var(--surface-1)',
      border: '1px solid var(--border-subtle)', borderRadius: 8,
    }}>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 800, marginTop: 2 }}>{value}</div>
      {hint && <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 2 }}>{hint}</div>}
    </div>
  );
}

function StatusBadge({ tone, label }) {
  const t =
    tone === 'success' ? { bg: 'color-mix(in srgb, var(--success) 16%, transparent)', fg: 'var(--success)' }
  : tone === 'warning' ? { bg: 'color-mix(in srgb, var(--warning) 16%, transparent)', fg: 'var(--warning)' }
  : tone === 'danger'  ? { bg: 'color-mix(in srgb, var(--danger)  16%, transparent)', fg: 'var(--danger)'  }
                       : { bg: 'var(--surface-2)', fg: 'var(--text-muted)' };
  return (
    <span style={{
      display: 'inline-flex', padding: '2px 8px', borderRadius: 999,
      fontSize: 10.5, fontWeight: 700, whiteSpace: 'nowrap',
      background: t.bg, color: t.fg,
    }}>{label}</span>
  );
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ============================================================
// Compose — Brand → Product → Promotions editor → Review
// ============================================================
const STEPS = [
  { key: 'target',  label: 'Product'    },
  { key: 'promos',  label: 'Promotions' },
  { key: 'review',  label: 'Review'     },
];

const PROMO_TYPES = [
  { v: 'individual', label: 'Individual' },
  { v: 'cart',       label: 'Cart-level' },
  { v: 'coupon',     label: 'Coupon'     },
];

function newBlankPromo() {
  return {
    id:         'p_' + Math.random().toString(36).slice(2, 10),
    type:       'individual',
    name:       '',
    discount:   0,
    start_date: '',
    end_date:   '',
    status:     'active',
  };
}

function ComposeStepModal({ brands, onClose, onSaved }) {
  const [step, setStep]       = useState(0);
  const [brandId, setBrandId] = useState('');
  const [productId, setPid]   = useState('');
  const [promotions, setPromotions] = useState([]);     // live-edited array
  const [skuOverrides, setSkuOverrides] = useState({}); // { sku_id: { promo_id: discount } }
  const [pasteOpen, setPasteOpen] = useState(false);
  const [paste, setPaste]     = useState('');
  const [saving, setSaving]   = useState(false);
  const [err, setErr]         = useState('');

  const { data: products = [] } = useQuery({
    queryKey: ['brand-products', brandId],
    queryFn:  () => listProducts(brandId),
    enabled:  !!brandId,
  });

  useEffect(() => { setPid(''); }, [brandId]);

  const selectedProduct = products.find((p) => p.id === productId);
  const skus = selectedProduct?.skus || [];

  function applyPaste() {
    if (!paste.trim()) return;
    try {
      const { promotions: parsed } = parsePastedPromotion(paste);
      if (parsed.length === 0) {
        setErr('Couldn\'t parse any promotions from the paste.');
        return;
      }
      // Append (not replace) so users can paste multiple times or mix with manual.
      setPromotions((cur) => [...cur, ...parsed]);
      setPaste('');
      setPasteOpen(false);
      setErr('');
    } catch { setErr('Paste parse failed.'); }
  }

  function addBlankPromo()          { setPromotions((cur) => [...cur, newBlankPromo()]); }
  function updatePromo(id, patch)   {
    setPromotions((cur) => cur.map((p) => p.id === id ? { ...p, ...patch } : p));
  }
  function removePromo(id)          {
    setPromotions((cur) => cur.filter((p) => p.id !== id));
    // also drop any sku overrides for this promo
    setSkuOverrides((cur) => {
      const next = {};
      for (const sid of Object.keys(cur)) {
        const entry = { ...cur[sid] };
        delete entry[id];
        if (Object.keys(entry).length) next[sid] = entry;
      }
      return next;
    });
  }

  function setSkuDiscount(skuId, promoId, value) {
    setSkuOverrides((cur) => {
      const next  = { ...cur };
      const entry = { ...(next[skuId] || {}) };
      if (value === '' || value == null) delete entry[promoId];
      else entry[promoId] = Number(value);
      if (Object.keys(entry).length) next[skuId] = entry;
      else delete next[skuId];
      return next;
    });
  }

  function canAdvance() {
    if (step === 0) return !!brandId && !!productId;
    if (step === 1) {
      return promotions.length > 0
        && promotions.every((p) => Number(p.discount) > 0);
    }
    return true;
  }

  async function save() {
    setErr(''); setSaving(true);
    try {
      // Sanitize: trim names, drop any rows with no discount
      const clean = promotions
        .filter((p) => Number(p.discount) > 0)
        .map((p) => ({
          id:         p.id,
          type:       p.type || 'individual',
          name:       (p.name || '').trim(),
          discount:   Number(p.discount),
          start_date: p.start_date || '',
          end_date:   p.end_date   || '',
          status:     (p.end_date && p.end_date < todayStr()) ? 'expired' : 'active',
        }));
      if (clean.length === 0) throw new Error('Add at least one promotion with a discount.');

      await createCampaign({
        productId,
        promotions:   clean,
        skuOverrides,
        rawPaste:     paste || null,
      });
      onSaved();
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  }

  function todayStr() { return new Date().toISOString().slice(0, 10); }

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose();
      else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        if (step < 2 && canAdvance()) setStep(step + 1);
        else if (step === 2 && !saving) save();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, brandId, productId, promotions, saving]);

  return (
    <div className="wx-modal-backdrop wx-m-backdrop" onClick={onClose}>
      <div className="wx-modal" style={{ maxWidth: 700 }} onClick={(e) => e.stopPropagation()}>
        <div className="wx-m-head">
          <div className="wx-m-head-icon"><BoxIcon width="18" height="18" /></div>
          <div className="wx-m-head-text">
            <div className="wx-m-head-title">New product campaign</div>
            <div className="wx-m-head-sub">Pick the brand + an existing product, then paste the Seller Center text.</div>
          </div>
          <button type="button" className="wx-m-head-close" onClick={onClose}><XIcon width="14" height="14" /></button>
        </div>

        <div className="wx-m-stepper">
          {STEPS.map((s, i) => (
            <span key={s.key} className={`wx-m-step ${i === step ? 'is-active' : i < step ? 'is-done' : ''}`}>
              <span className="wx-m-step-dot">{i < step ? <CheckIcon width="10" height="10" /> : i + 1}</span>
              {s.label}
              {i < STEPS.length - 1 && <span className="wx-m-step-sep" style={{ width: 24, flex: 'none' }} />}
            </span>
          ))}
        </div>

        <div className="wx-m-body">
          {err && <div className="wx-alert wx-alert-danger"><AlertIcon width="14" height="14" /> <span>{err}</span></div>}

          {step === 0 && (
            <>
              <div className="wx-m-field">
                <div className="wx-m-field-head">
                  <div className="wx-m-field-label">Brand</div>
                  <div className="wx-m-field-meta is-required">Required</div>
                </div>
                <select className="wx-m-input" value={brandId} onChange={(e) => setBrandId(e.target.value)}>
                  <option value="">— pick a brand —</option>
                  {brands.map((b) => <option key={b.id} value={b.id}>{b.brand_name}</option>)}
                </select>
              </div>

              {brandId && (
                <div className="wx-m-field">
                  <div className="wx-m-field-head">
                    <div className="wx-m-field-label">Product</div>
                    <div className="wx-m-field-meta is-required">
                      {products.length ? `${products.length} available` : 'No products yet'}
                    </div>
                  </div>
                  {products.length === 0 ? (
                    <div className="wx-alert" style={{
                      background: 'color-mix(in srgb, var(--warning) 10%, var(--surface-1))',
                      border: '1px solid color-mix(in srgb, var(--warning) 40%, var(--border-subtle))',
                      color: 'var(--text-primary)',
                    }}>
                      This brand has no products yet. Open the brand → Products tab and add one first.
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {products.map((p) => (
                        <button key={p.id} type="button"
                          className={`wx-m-card ${productId === p.id ? 'is-active' : ''}`}
                          onClick={() => setPid(p.id)}
                          style={{ display: 'block', textAlign: 'left' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                            <div style={{ minWidth: 0 }}>
                              <div className="wx-m-card-title">{p.product_name}</div>
                              <div className="wx-m-card-sub">
                                {p.type === 'focus' ? 'Focus' : 'Non-focus'} · ${Number(p.retail_price || 0).toFixed(2)}
                                {(p.skus || []).length > 0 && ` · ${p.skus.length} SKU${p.skus.length === 1 ? '' : 's'}`}
                              </div>
                            </div>
                            {productId === p.id && <CheckIcon width="14" height="14" style={{ color: 'var(--accent)' }} />}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {step === 1 && (
            <>
              {selectedProduct && (
                <div style={{
                  padding: 10, background: 'var(--surface-1)',
                  border: '1px solid var(--border-subtle)', borderRadius: 8,
                  fontSize: 12.5, display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}>
                  <div>
                    <div style={{ fontWeight: 700 }}>{selectedProduct.product_name}</div>
                    <div style={{ color: 'var(--text-muted)' }}>
                      Retail ${Number(selectedProduct.retail_price || 0).toFixed(2)}
                      {skus.length > 0 && ` · ${skus.length} SKU${skus.length === 1 ? '' : 's'}`}
                    </div>
                  </div>
                </div>
              )}

              {/* Header with Add + Paste actions */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                <div className="wx-m-field-label">
                  Promotions {promotions.length > 0 && (
                    <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>· {promotions.length}</span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button type="button" className="wx-btn wx-btn-ghost"
                    onClick={() => setPasteOpen((v) => !v)}>
                    {pasteOpen ? 'Hide paste' : 'Paste Price Breakdown'}
                  </button>
                  <button type="button" className="wx-btn wx-btn-primary" onClick={addBlankPromo}>
                    <PlusIcon width="13" height="13" /> Add promotion
                  </button>
                </div>
              </div>

              {/* Collapsible paste area */}
              {pasteOpen && (
                <div className="wx-m-textarea-shell" style={{ position: 'relative' }}>
                  <textarea rows={7} value={paste}
                    onChange={(e) => setPaste(e.target.value)}
                    placeholder={
                      'Paste from Seller Center. Example:\n\nIndividual product promotion\n$19.99\nSpring discount\nApr 10, 2026 9:00 AM GMT-7 - Apr 30, 2026 11:59 PM GMT-7'
                    }
                    style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
                  />
                  <div style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '6px 10px 8px', gap: 6,
                  }}>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{paste.length} chars</div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button type="button" className="wx-btn wx-btn-ghost" onClick={() => { setPaste(''); setPasteOpen(false); }}>Cancel</button>
                      <button type="button" className="wx-btn wx-btn-primary" onClick={applyPaste} disabled={!paste.trim()}>
                        Append parsed
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Promotion rows */}
              {promotions.length === 0 ? (
                <div style={{
                  padding: 16, border: '1px dashed var(--border-subtle)',
                  borderRadius: 10, textAlign: 'center', fontSize: 12.5, color: 'var(--text-muted)',
                }}>
                  No promotions yet. Click <strong>Add promotion</strong> or paste from Seller Center.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {promotions.map((p) => (
                    <PromoEditRow
                      key={p.id}
                      promo={p}
                      skus={skus}
                      skuOverrides={skuOverrides}
                      onChange={(patch) => updatePromo(p.id, patch)}
                      onRemove={() => removePromo(p.id)}
                      onSkuChange={(skuId, val) => setSkuDiscount(skuId, p.id, val)}
                    />
                  ))}
                </div>
              )}
            </>
          )}

          {step === 2 && (
            <div className="wx-m-review">
              <Review k="Brand"   v={brands.find((b) => b.id === brandId)?.brand_name || '—'} />
              <Review k="Product" v={selectedProduct?.product_name || '—'} />
              <Review k="Retail"  v={`$${Number(selectedProduct?.retail_price || 0).toFixed(2)}`} />
              <Review k="Promotions" v={
                promotions.length === 0
                  ? '—'
                  : promotions.map((p) =>
                      `${PROMO_TYPE_LABEL[p.type] || p.type}: $${Number(p.discount || 0).toFixed(2)}` +
                      (p.name ? ` (${p.name})` : '')
                    ).join(' · ')
              } />
              {Object.keys(skuOverrides).length > 0 && (
                <Review k="SKU overrides" v={`${Object.keys(skuOverrides).length} SKU${Object.keys(skuOverrides).length === 1 ? '' : 's'} customised`} />
              )}
            </div>
          )}
        </div>

        <div className="wx-m-foot">
          <div className="wx-m-kbd-hints">
            <kbd>Esc</kbd> cancel <span>·</span> <kbd>⌘</kbd><kbd>↵</kbd> {step < 2 ? 'next' : 'save'}
          </div>
          <div className="wx-m-foot-actions">
            {step > 0 && <button type="button" className="wx-btn wx-btn-ghost" onClick={() => setStep(step - 1)} disabled={saving}>Back</button>}
            {step < 2 ? (
              <button type="button" className="wx-btn wx-btn-primary" onClick={() => setStep(step + 1)} disabled={!canAdvance()}>Continue</button>
            ) : (
              <button type="button" className="wx-btn wx-btn-primary" onClick={save} disabled={saving}>
                {saving ? <><span className="wx-spinner" /> Saving…</> : <><CheckIcon width="14" height="14" /> Save</>}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Review({ k, v }) {
  return (
    <div className="wx-m-review-row">
      <div className="wx-m-review-k">{k}</div>
      <div className="wx-m-review-v">{v}</div>
    </div>
  );
}

function PromoRow({ promo }) {
  const meta = STATUS_META[promo.status === 'expired' ? 'expired' : 'active'];
  return (
    <div style={{
      padding: 10, border: '1px solid var(--border-subtle)',
      borderRadius: 8, background: 'var(--surface-1)',
      display: 'grid', gridTemplateColumns: '1fr auto', gap: 6,
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 700 }}>{promo.name || PROMO_TYPE_LABEL[promo.type]}</div>
        <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
          {PROMO_TYPE_LABEL[promo.type] || promo.type} · ${Number(promo.discount || 0).toFixed(2)}
          {promo.start_date && promo.end_date && ` · ${fmtDate(promo.start_date)} → ${fmtDate(promo.end_date)}`}
        </div>
      </div>
      <StatusBadge tone={meta.tone} label={meta.label} />
    </div>
  );
}

// Editable row used during compose. Collapses the SKU override UI
// under an expand toggle so the main form stays clean.
function PromoEditRow({ promo, skus, skuOverrides, onChange, onRemove, onSkuChange }) {
  const [showSkus, setShowSkus] = useState(false);
  const hasSkus = skus && skus.length > 0;
  const overridesForThis = Object.entries(skuOverrides || {}).filter(([, v]) => v && v[promo.id] != null).length;

  return (
    <div style={{
      padding: 10, border: '1px solid var(--border-subtle)',
      borderRadius: 10, background: 'var(--surface-1)',
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{ display: 'grid', gridTemplateColumns: '130px 1fr 110px auto', gap: 6 }}>
        <select className="wx-m-input" value={promo.type}
          onChange={(e) => onChange({ type: e.target.value })}>
          {PROMO_TYPES.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
        </select>
        <input className="wx-m-input" value={promo.name}
          placeholder="Name (optional)"
          onChange={(e) => onChange({ name: e.target.value })} />
        <input type="number" step="0.01" min="0" className="wx-m-input"
          value={promo.discount === 0 ? '' : promo.discount}
          placeholder="Discount"
          onChange={(e) => onChange({ discount: Number(e.target.value || 0) })} />
        <button type="button" className="wx-btn wx-btn-ghost" onClick={onRemove} aria-label="Remove">
          <TrashIcon width="13" height="13" />
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: 10.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Start</span>
          <input type="date" className="wx-m-input" value={promo.start_date || ''}
            onChange={(e) => onChange({ start_date: e.target.value })} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: 10.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>End</span>
          <input type="date" className="wx-m-input" value={promo.end_date || ''}
            onChange={(e) => onChange({ end_date: e.target.value })} />
        </label>
      </div>

      {hasSkus && (
        <div>
          <button type="button" className="wx-btn wx-btn-ghost" style={{ fontSize: 11.5 }}
            onClick={() => setShowSkus((v) => !v)}>
            {showSkus ? 'Hide SKU overrides' : 'Per-SKU discount overrides'}
            {overridesForThis > 0 && (
              <span style={{
                marginLeft: 6, padding: '1px 6px', borderRadius: 999,
                background: 'var(--accent-soft)', color: 'var(--accent)', fontSize: 10,
              }}>{overridesForThis}</span>
            )}
          </button>
          {showSkus && (
            <div style={{
              marginTop: 6, padding: 8, borderRadius: 8,
              background: 'var(--surface-2)', display: 'flex', flexDirection: 'column', gap: 4,
            }}>
              {skus.map((s) => {
                const override = skuOverrides?.[s.id]?.[promo.id];
                const value = override != null ? override : '';
                return (
                  <div key={s.id} style={{
                    display: 'grid', gridTemplateColumns: '1fr 110px auto', gap: 6, alignItems: 'center',
                  }}>
                    <div style={{ fontSize: 12.5, minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>{s.sku_name}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Retail ${Number(s.retail_price || 0).toFixed(2)}</div>
                    </div>
                    <input type="number" step="0.01" min="0" className="wx-m-input"
                      placeholder={`Primary $${Number(promo.discount || 0).toFixed(2)}`}
                      value={value}
                      onChange={(e) => onSkuChange(s.id, e.target.value)} />
                    <button type="button" className="wx-btn wx-btn-ghost"
                      disabled={override == null}
                      onClick={() => onSkuChange(s.id, '')}
                      title="Reset to primary">
                      Reset
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================
// Detail modal
// ============================================================
function CampaignDetailModal({ row, canWrite, onClose, onChanged }) {
  const [deleting, setDeleting] = useState(false);
  const [err, setErr] = useState('');

  async function handleDelete() {
    if (!confirm(`Delete this campaign for "${row.product?.product_name}"?`)) return;
    setDeleting(true); setErr('');
    try { await deleteCampaign(row.id); onChanged(); onClose(); }
    catch (e) { setErr(e.message); }
    finally { setDeleting(false); }
  }

  return (
    <div className="wx-modal-backdrop wx-m-backdrop" onClick={onClose}>
      <div className="wx-modal" style={{ maxWidth: 720 }} onClick={(e) => e.stopPropagation()}>
        <div className="wx-m-head">
          <div className="wx-m-head-icon"><BoxIcon width="18" height="18" /></div>
          <div className="wx-m-head-text">
            <div style={{ fontSize: 10.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {row.brand?.brand_name || '—'}
            </div>
            <div className="wx-m-head-title" style={{ marginTop: 2 }}>
              {row.product?.product_name || 'Unknown product'}
            </div>
          </div>
          <button type="button" className="wx-m-head-close" onClick={onClose}><XIcon width="14" height="14" /></button>
        </div>

        <div className="wx-m-body">
          {err && <div className="wx-alert wx-alert-danger"><AlertIcon width="14" height="14" /> <span>{err}</span></div>}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
            <Stat label="Retail" value={`$${Number(row.product?.retail_price || 0).toFixed(2)}`} />
            <Stat label="Type"   value={row.product?.type === 'focus' ? 'Focus' : 'Non-focus'} />
            <Stat label="Status" value={STATUS_META[row._status]?.label || row._status} />
            {row.latest_end_date && <Stat label="Latest end" value={fmtDate(row.latest_end_date)} />}
          </div>

          {row.product?.product_url && (
            <a href={row.product.product_url} target="_blank" rel="noreferrer"
              className="wx-btn wx-btn-ghost" style={{ alignSelf: 'flex-start' }}>
              <LinkIcon width="13" height="13" /> Open product on TikTok Shop
            </a>
          )}

          <div>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
              Promotions ({(row.promotions || []).length})
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {(row.promotions || []).map((p, i) => <PromoRow key={p.id || i} promo={p} />)}
            </div>
          </div>

          {(row.product?.skus || []).length > 0 && (
            <div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                SKUs ({row.product.skus.length})
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {row.product.skus.map((s) => (
                  <div key={s.id} style={{
                    display: 'flex', justifyContent: 'space-between',
                    padding: '6px 10px', border: '1px solid var(--border-subtle)',
                    borderRadius: 6, background: 'var(--surface-1)', fontSize: 12.5,
                  }}>
                    <span>{s.sku_name}</span>
                    <span style={{ color: 'var(--text-muted)' }}>${Number(s.retail_price || 0).toFixed(2)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {row.raw_paste && (
            <details>
              <summary style={{ fontSize: 12.5, cursor: 'pointer', color: 'var(--text-muted)' }}>Original paste</summary>
              <pre style={{
                marginTop: 6, padding: 10, borderRadius: 8,
                background: 'var(--surface-2)', fontSize: 11.5,
                maxHeight: 180, overflow: 'auto', whiteSpace: 'pre-wrap',
              }}>{row.raw_paste}</pre>
            </details>
          )}
        </div>

        <div className="wx-m-foot">
          <div className="wx-m-kbd-hints"><kbd>Esc</kbd> close</div>
          <div className="wx-m-foot-actions">
            {canWrite && (
              <button className="wx-btn wx-btn-ghost" onClick={handleDelete} disabled={deleting}>
                <TrashIcon width="13" height="13" /> Delete
              </button>
            )}
            <button className="wx-btn wx-btn-primary" onClick={onClose}>Done</button>
          </div>
        </div>
      </div>
    </div>
  );
}
