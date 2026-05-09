// VERBATIM PORT of v1 ProductCampaignsPage.js (921 LOC).
// Surgical patches only:
//   1. Firebase imports → v1-compat shim (productCampaignsApiV1.js)
//   2. useAuth() returns {user, profile} in v2 → reconstruct
//      v1's {currentUser, userRole, apcProfile}
//   3. getDocs(brands/{id}/products) → listProductsForBrand
//   4. setDoc/updateDoc(productCampaigns) → saveProductCampaign
//   5. deleteDoc → removeProductCampaign
//   6. The auto-expire pass uses updatePromotionStatuses
import React, { useEffect, useState, useMemo } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useBrands } from '../../contexts/BrandsContext';
import { supabase } from '../../lib/supabase';
import {
  listProductsForBrand,
  listAllProductCampaigns,
  saveProductCampaign,
  updatePromotionStatuses,
  removeProductCampaign,
} from '../../lib/productCampaignsApiV1';

const PROMO_TYPES = [
  { key: 'individual',  label: 'Individual Product Promotion', icon: 'bi-tag',      color: '#0d6efd', bg: '#e8f0fe' },
  { key: 'cart_level',  label: 'Cart Level Promotion',         icon: 'bi-cart',     color: '#198754', bg: '#e6f4ea' },
  { key: 'coupon',      label: 'Coupon',                       icon: 'bi-ticket-perforated', color: '#6610f2', bg: '#f0ebff' },
];

function getPromoCfg(type) { return PROMO_TYPES.find(p => p.key === type) || PROMO_TYPES[0]; }

function parseDollar(s) { return parseFloat((s || '').replace(/[$,]/g, '')) || 0; }

function formatDate(d) {
  if (!d) return '—';
  const date = d.toDate ? d.toDate() : new Date(d);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function daysUntil(d) {
  if (!d) return Infinity;
  // Parse YYYY-MM-DD as local date (not UTC) to avoid timezone shift
  const str = typeof d === 'string' ? d : (d.toDate ? d.toDate().toISOString().split('T')[0] : new Date(d).toISOString().split('T')[0]);
  const [y, m, day] = str.split('-').map(Number);
  const date = new Date(y, m - 1, day); date.setHours(0, 0, 0, 0);
  const now = new Date(); now.setHours(0, 0, 0, 0);
  return Math.ceil((date - now) / 86400000);
}

function computeFinalPrice(product) {
  if (!product) return 0;
  let total = product.retailPrice || 0;
  (product.promotions || []).forEach(p => {
    if (p.status !== 'expired') total -= (p.discount || 0);
  });
  return Math.max(0, total);
}

function genId(prefix) { return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`; }
function ensurePromoIds(promos) {
  return (promos || []).map(p => p && p.id ? p : { ...(p || {}), id: genId('p') });
}
function computeSkuFinalPrice(productPromos, sku) {
  let total = parseFloat(sku?.retailPrice) || 0;
  (productPromos || []).forEach(pr => {
    if (pr.status === 'expired') return;
    const ov = sku?.promoDiscounts?.[pr.id];
    const d = ov != null && ov !== '' ? (parseFloat(ov) || 0) : (pr.discount || 0);
    total -= d;
  });
  return Math.max(0, total);
}

// Helper: true if line is JUST a dollar amount like "$24.00", false if it has extra text
function isPureDollar(s) { return /^\$[\d,.]+$/.test(s.trim()); }
function isSectionHeader(s) {
  const l = s.toLowerCase();
  return l.includes('retail price') || l.includes('individual product promotion')
    || l.includes('cart level promotion') || l === 'coupon' || l.includes('final price');
}

// ── Paste Parser ─────────────────────────────────────────────────────────────
function parseRawText(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const result = { retailPrice: 0, finalPrice: 0, promotions: [] };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.toLowerCase().includes('retail price')) {
      i++;
      if (i < lines.length) result.retailPrice = parseDollar(lines[i]);
    }
    else if (line.toLowerCase().includes('individual product promotion')) {
      i++;
      const promo = { type: 'individual', discount: 0, name: '', startDate: '', endDate: '' };
      if (i < lines.length) promo.discount = parseDollar(lines[i]);
      i++;
      if (i < lines.length && !isPureDollar(lines[i]) && !isSectionHeader(lines[i]) && !lines[i].includes(' - ')) {
        promo.name = lines[i].replace(/^Schedule Campaign price\s*\d+\s*/, '').trim(); i++;
      }
      if (i < lines.length && isPureDollar(lines[i])) i++;
      if (i < lines.length && lines[i].includes(' - ')) {
        const dates = parseDateRange(lines[i]);
        promo.startDate = dates.start; promo.endDate = dates.end;
      }
      if (promo.discount > 0) result.promotions.push(promo);
    }
    else if (line.toLowerCase().includes('cart level promotion')) {
      i++;
      const discount = i < lines.length ? parseDollar(lines[i]) : 0;
      if (discount > 0) {
        const promo = { type: 'cart_level', discount, name: '', startDate: '', endDate: '' };
        i++;
        if (i < lines.length && !isPureDollar(lines[i]) && !isSectionHeader(lines[i]) && !lines[i].includes(' - ')) {
          promo.name = lines[i].trim(); i++;
        }
        if (i < lines.length && isPureDollar(lines[i])) i++;
        if (i < lines.length && lines[i].includes(' - ')) {
          const dates = parseDateRange(lines[i]);
          promo.startDate = dates.start; promo.endDate = dates.end;
        }
        result.promotions.push(promo);
      }
    }
    else if (line.toLowerCase() === 'coupon') {
      i++;
      const promo = { type: 'coupon', discount: 0, name: '', startDate: '', endDate: '' };
      if (i < lines.length) promo.discount = parseDollar(lines[i]);
      i++;
      // Name may start with $ like "$24 off $120 StoreWide Coupon" — use isPureDollar to differentiate
      if (i < lines.length && !isPureDollar(lines[i]) && !isSectionHeader(lines[i]) && !lines[i].includes(' - ')) {
        promo.name = lines[i].replace(/\s*-\s*$/, '').trim(); i++;
      }
      if (i < lines.length && isPureDollar(lines[i])) i++;
      if (i < lines.length && lines[i].includes(' - ')) {
        const dates = parseDateRange(lines[i]);
        promo.startDate = dates.start; promo.endDate = dates.end;
      }
      if (promo.discount > 0) result.promotions.push(promo);
    }
    else if (line.toLowerCase().includes('final price')) {
      i++;
      if (i < lines.length) result.finalPrice = parseDollar(lines[i]);
    }

    i++;
  }

  return result;
}

function parseDateRange(line) {
  // "Apr 1, 2026 2:55 PM GMT-7 - Apr 22, 2026 4:59 PM GMT-7"
  const parts = line.split(' - ').map(s => s.trim());
  return {
    start: parts[0] ? parseLooseDate(parts[0]) : '',
    end: parts[1] ? parseLooseDate(parts[1]) : '',
  };
}

function parseLooseDate(s) {
  // Remove timezone info for parsing
  const cleaned = s.replace(/\s*GMT[+-]?\d*/i, '').trim();
  const d = new Date(cleaned);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().split('T')[0]; // YYYY-MM-DD
}

// ── Add/Edit Campaign Modal ─────────────────────────────────────────────────
function CampaignModal({ editProduct, brandId, brandName, onClose, onSaved }) {
  const { user, profile } = useAuth();
  const currentUser = user ? { uid: user.id, email: user.email, displayName: profile?.display_name || '' } : null;
  const userRole = profile?.role || '';
  const apcProfile = (userRole === 'apc' || userRole === 'ipc') ? { userName: profile?.display_name || '' } : null;

  const [promotions, setPromotions] = useState(() => ensurePromoIds(editProduct?.promotions || []));
  const [skus, setSkus] = useState(editProduct?.skus || []);
  const [pasteText, setPasteText] = useState('');
  const [showPaste, setShowPaste] = useState(false);
  const [parsed, setParsed] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [existingProducts, setExistingProducts] = useState([]);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState(
    editProduct ? { id: editProduct.id, productName: editProduct.productName, productId: editProduct.productId, retailPrice: editProduct.retailPrice, type: editProduct.type } : null
  );

  const isEdit = Boolean(editProduct);

  // Fetch existing products for this brand
  useEffect(() => {
    if (!brandId) return;
    setLoadingProducts(true);
    listProductsForBrand(brandId).then(rows => {
      setExistingProducts(rows);
    }).finally(() => setLoadingProducts(false));
  }, [brandId]);

  function handlePickProduct(pid) {
    if (!pid) { setSelectedProduct(null); setSkus([]); return; }
    const p = existingProducts.find(x => x.id === pid);
    if (!p) return;
    setSelectedProduct(p);
    setSkus(p.skus || []);
    if ((p.promotions || []).length > 0) setPromotions(ensurePromoIds(p.promotions));
  }

  function handleParse() {
    if (!pasteText.trim()) return;
    setParsed(parseRawText(pasteText));
  }

  function applyParsed() {
    if (!parsed) return;
    setPromotions(ensurePromoIds(parsed.promotions.map(p => ({ ...p, status: 'active' }))));
    setParsed(null); setPasteText(''); setShowPaste(false);
  }

  function updatePromo(index, field, value) {
    setPromotions(prev => prev.map((p, i) => i === index ? { ...p, [field]: value } : p));
  }
  function removePromo(index) { setPromotions(prev => prev.filter((_, i) => i !== index)); }
  function addPromo() {
    setPromotions(prev => [...prev, { id: genId('p'), type: 'individual', name: '', discount: 0, startDate: '', endDate: '', status: 'active' }]);
  }
  function setSkuPromoDiscount(skuIdx, promoId, value) {
    setSkus(prev => prev.map((s, i) => {
      if (i !== skuIdx) return s;
      const overrides = { ...(s.promoDiscounts || {}) };
      if (value === '' || value == null) delete overrides[promoId];
      else overrides[promoId] = value;
      return { ...s, promoDiscounts: overrides };
    }));
  }

  async function handleSave() {
    if (!selectedProduct) { setError('Please select a product.'); return; }
    if (promotions.length === 0) { setError('Add at least one promotion.'); return; }
    setError(''); setSaving(true);

    try {
      const promoData = promotions.map(p => ({
        id: p.id || genId('p'),
        type: p.type, name: (p.name || '').trim(), discount: parseFloat(p.discount) || 0,
        startDate: p.startDate || null, endDate: p.endDate || null, status: p.status || 'active',
      }));
      const validPromoIds = new Set(promoData.map(p => p.id));
      const skuData = (skus || [])
        .filter(s => (s.skuName || '').trim() || parseFloat(s.retailPrice) > 0)
        .map(s => ({
          id: s.id || genId('sku'),
          skuName: (s.skuName || '').trim(),
          retailPrice: parseFloat(s.retailPrice) || 0,
          promoDiscounts: Object.fromEntries(
            Object.entries(s.promoDiscounts || {})
              .filter(([pid, v]) => validPromoIds.has(pid) && v !== '' && v != null)
              .map(([pid, v]) => [pid, parseFloat(v) || 0])
          ),
        }));

      // Save via the v1-compat shim — handles brand_products.skus +
      // product_campaigns upsert in one call.
      const saved = await saveProductCampaign({
        productId: selectedProduct.id,
        brandId,
        brandName,
        promotions: promoData,
        skus: skuData,
        isEdit,
      });

      onSaved(saved);
    } catch { setError('Failed to save. Please try again.'); }
    setSaving(false);
  }

  const retailPrice = selectedProduct?.retailPrice || 0;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1070, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(2px)' }} onClick={onClose} />
      <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 560, zIndex: 1, borderRadius: 14, maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        <div className="card-header bg-white border-0 pt-4 pb-2 px-4 d-flex align-items-center justify-content-between" style={{ borderRadius: '14px 14px 0 0', flexShrink: 0 }}>
          <div>
            <h6 className="fw-bold mb-0">{isEdit ? 'Edit Campaign' : 'Add Campaign'}</h6>
            <p className="text-muted small mb-0">{brandName}</p>
          </div>
          <button className="btn btn-sm btn-light border-0 px-2" onClick={onClose}><i className="bi bi-x-lg" /></button>
        </div>
        <div className="card-body px-4 pb-4 pt-2" style={{ overflowY: 'auto' }}>
          {error && <div className="alert alert-danger py-2 small mb-3">{error}</div>}

          {/* Product picker (required) */}
          {!isEdit ? (
            <div className="mb-3">
              <label className="form-label small fw-semibold mb-1">Select Product *</label>
              <select className="form-select form-select-sm" defaultValue=""
                onChange={e => handlePickProduct(e.target.value)} style={{ fontSize: '0.78rem' }}
                disabled={loadingProducts}>
                <option value="">{loadingProducts ? 'Loading products...' : '— Select a product —'}</option>
                {existingProducts.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.productName}{p.productId ? ` (${p.productId})` : ''} — ${(p.retailPrice || 0).toFixed(2)}
                  </option>
                ))}
              </select>
              {existingProducts.length === 0 && !loadingProducts && (
                <div className="text-muted mt-1" style={{ fontSize: '0.65rem' }}>No products found for this brand. Add products from the brand's Products tab first.</div>
              )}
            </div>
          ) : (
            <div className="rounded-3 p-3 mb-3 d-flex align-items-center gap-3" style={{ background: '#f8f9fa' }}>
              <div>
                <div className="fw-bold small">{selectedProduct?.productName}</div>
                <div className="text-muted" style={{ fontSize: '0.68rem' }}>
                  {selectedProduct?.productId && `ID: ${selectedProduct.productId} · `}Retail: ${retailPrice.toFixed(2)}
                </div>
              </div>
            </div>
          )}

          {/* Selected product info */}
          {!isEdit && selectedProduct && (
            <div className="rounded-3 p-3 mb-3 d-flex align-items-center gap-3" style={{ background: '#f0fdf4', border: '1px solid #bbf7d0' }}>
              <i className="bi bi-check-circle-fill text-success" />
              <div>
                <div className="fw-bold small">{selectedProduct.productName}</div>
                <div className="text-muted" style={{ fontSize: '0.68rem' }}>
                  {selectedProduct.productId && `ID: ${selectedProduct.productId} · `}Retail: ${retailPrice.toFixed(2)}
                </div>
              </div>
            </div>
          )}

          {/* Paste parser */}
          <button type="button" className="btn btn-sm btn-outline-primary d-inline-flex align-items-center gap-1 mb-3"
            onClick={() => setShowPaste(!showPaste)} style={{ fontSize: '0.78rem' }}>
            <i className="bi bi-clipboard" /> {showPaste ? 'Hide Paste Parser' : 'Paste Price Breakdown'}
          </button>

          {showPaste && (
            <div className="card border-0 rounded-3 mb-3" style={{ background: '#f0f4ff', border: '1px solid #c5d5ff' }}>
              <div className="card-body p-3">
                <textarea className="form-control form-control-sm mb-2" rows={6} value={pasteText}
                  onChange={e => setPasteText(e.target.value)}
                  placeholder="Paste the price breakdown from TikTok Shop here..." style={{ fontSize: '0.78rem' }} />
                <button className="btn btn-sm btn-primary" onClick={handleParse} disabled={!pasteText.trim()}>
                  <i className="bi bi-magic me-1" /> Parse
                </button>

                {parsed && (
                  <div className="mt-3 rounded-2 p-3" style={{ background: '#fff', border: '1px solid #e2e8f0' }}>
                    <div className="small fw-semibold mb-2">Parsed Data:</div>
                    {parsed.promotions.map((p, i) => (
                      <div key={i} className="small mb-1">
                        <span className="badge rounded-pill me-1" style={{ background: getPromoCfg(p.type).bg, color: getPromoCfg(p.type).color, fontSize: '0.62rem' }}>
                          {getPromoCfg(p.type).label}
                        </span>
                        −${p.discount} {p.name && `· ${p.name}`} {p.endDate && `· ends ${p.endDate}`}
                      </div>
                    ))}
                    <div className="small mt-1">Final: <strong>${parsed.finalPrice}</strong></div>
                    <button className="btn btn-sm btn-dark mt-2" onClick={applyParsed}>
                      <i className="bi bi-check-lg me-1" /> Apply
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Promotions */}
          <div className="d-flex align-items-center justify-content-between mb-2">
            <span className="small fw-semibold text-muted text-uppercase" style={{ letterSpacing: '0.06em', fontSize: '0.68rem' }}>Promotions ({promotions.length})</span>
            <button type="button" className="btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1" style={{ fontSize: '0.72rem' }} onClick={addPromo}>
              <i className="bi bi-plus" /> Add
            </button>
          </div>

          {promotions.length === 0 && (
            <p className="text-muted small mb-3">No promotions added. Use the paste parser or add manually.</p>
          )}

          {promotions.map((p, i) => {
            const cfg = getPromoCfg(p.type);
            return (
              <div key={i} className="card border-0 rounded-3 mb-2" style={{ background: '#f8f9fa' }}>
                <div className="card-body p-3">
                  <div className="d-flex align-items-center justify-content-between mb-2">
                    <select className="form-select form-select-sm" style={{ width: 'auto', fontSize: '0.78rem' }}
                      value={p.type} onChange={e => updatePromo(i, 'type', e.target.value)}>
                      {PROMO_TYPES.map(pt => <option key={pt.key} value={pt.key}>{pt.label}</option>)}
                    </select>
                    <button className="btn btn-sm btn-link text-danger p-0" onClick={() => removePromo(i)}>
                      <i className="bi bi-trash3" />
                    </button>
                  </div>
                  <div className="mb-2">
                    <input className="form-control form-control-sm" value={p.name} onChange={e => updatePromo(i, 'name', e.target.value)} placeholder="Campaign/coupon name" />
                  </div>
                  <div className="row g-2">
                    <div className="col-4">
                      <input type="number" step="0.01" className="form-control form-control-sm" value={p.discount} onChange={e => updatePromo(i, 'discount', e.target.value)} placeholder="Discount $" />
                    </div>
                    <div className="col-4">
                      <input type="date" className="form-control form-control-sm" value={p.startDate} onChange={e => updatePromo(i, 'startDate', e.target.value)} />
                    </div>
                    <div className="col-4">
                      <input type="date" className="form-control form-control-sm" value={p.endDate} onChange={e => updatePromo(i, 'endDate', e.target.value)} />
                    </div>
                  </div>
                </div>
              </div>
            );
          })}

          {/* Final price preview (primary) */}
          {retailPrice > 0 && promotions.length > 0 && (
            <div className="rounded-3 p-3 mb-3 d-flex align-items-center justify-content-between" style={{ background: '#0f172a', color: '#fff' }}>
              <div>
                <div className="small fw-semibold">Final Price</div>
                <div className="text-muted" style={{ fontSize: '0.62rem' }}>Primary product</div>
              </div>
              <span className="fw-bold" style={{ fontSize: '1.1rem' }}>
                ${computeFinalPrice({ retailPrice, promotions }).toFixed(2)}
              </span>
            </div>
          )}

          {/* SKU variants — per-promo discount overrides */}
          {selectedProduct && skus.length > 0 && (
            <div className="mb-3">
              <div className="d-flex align-items-center justify-content-between mb-2">
                <span className="small fw-semibold text-muted text-uppercase" style={{ letterSpacing: '0.06em', fontSize: '0.68rem' }}>
                  SKU Variants ({skus.length})
                </span>
                <span className="text-muted" style={{ fontSize: '0.65rem' }}>Override discount per SKU</span>
              </div>
              {promotions.length === 0 ? (
                <div className="text-muted small" style={{ fontSize: '0.72rem' }}>
                  Add promotions above first — SKU overrides will appear here.
                </div>
              ) : (
                <div className="d-flex flex-column gap-2">
                  {skus.map((s, idx) => {
                    const sFinal = computeSkuFinalPrice(promotions, s);
                    return (
                      <div key={s.id || idx} className="rounded-3 p-3" style={{ background: '#f8fafc', border: '1px solid #e2e8f0' }}>
                        <div className="d-flex align-items-center justify-content-between mb-2 flex-wrap gap-2">
                          <div>
                            <div className="fw-bold" style={{ fontSize: '0.82rem' }}>{s.skuName || 'Unnamed SKU'}</div>
                            <div className="text-muted" style={{ fontSize: '0.65rem' }}>
                              Retail ${parseFloat(s.retailPrice || 0).toFixed(2)}
                            </div>
                          </div>
                          {parseFloat(s.retailPrice) > 0 && (
                            <div className="text-end">
                              <div className="text-muted" style={{ fontSize: '0.6rem', fontWeight: 600, textTransform: 'uppercase' }}>Final</div>
                              <div className="fw-bold" style={{ fontSize: '0.95rem', color: '#198754' }}>${sFinal.toFixed(2)}</div>
                            </div>
                          )}
                        </div>
                        <div className="d-flex flex-column gap-1">
                          {promotions.map(pr => {
                            const cfg = getPromoCfg(pr.type);
                            const overrideVal = s.promoDiscounts?.[pr.id];
                            const effective = overrideVal != null && overrideVal !== '' ? overrideVal : (pr.discount || 0);
                            return (
                              <div key={pr.id} className="d-flex align-items-center gap-2 flex-wrap">
                                <span className="d-inline-flex align-items-center gap-1 rounded-pill px-2"
                                  style={{ background: cfg.bg, color: cfg.color, fontSize: '0.62rem', fontWeight: 600, lineHeight: '20px', minWidth: 0, flex: '1 1 auto' }}>
                                  <i className={`bi ${cfg.icon}`} style={{ fontSize: '0.55rem' }} />
                                  <span className="text-truncate">{pr.name || cfg.label}</span>
                                </span>
                                <div className="d-flex align-items-center gap-1" style={{ flex: '0 0 auto' }}>
                                  <span className="text-muted" style={{ fontSize: '0.62rem' }}>−$</span>
                                  <input type="number" step="0.01" className="form-control form-control-sm"
                                    style={{ width: 90, fontSize: '0.78rem', borderRadius: 6 }}
                                    value={overrideVal != null ? overrideVal : ''}
                                    placeholder={String(pr.discount || 0)}
                                    onChange={e => setSkuPromoDiscount(idx, pr.id, e.target.value)} />
                                  {overrideVal != null && overrideVal !== '' && (
                                    <button type="button" className="btn btn-sm btn-link text-muted p-0"
                                      title="Reset to primary discount"
                                      onClick={() => setSkuPromoDiscount(idx, pr.id, '')}
                                      style={{ fontSize: '0.7rem' }}>
                                      <i className="bi bi-arrow-counterclockwise" />
                                    </button>
                                  )}
                                </div>
                                <span className="text-muted" style={{ fontSize: '0.6rem', minWidth: 50, textAlign: 'right' }}>
                                  uses ${parseFloat(effective || 0).toFixed(2)}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="text-muted mt-2" style={{ fontSize: '0.65rem' }}>
                <i className="bi bi-info-circle me-1" />
                SKU lifecycle follows the primary — when a promotion ends here, it ends on every SKU. Edit SKU name &amp; retail in the brand's Products tab.
              </div>
            </div>
          )}

          <div className="d-flex gap-2">
            <button className="btn btn-dark btn-sm px-4" onClick={handleSave} disabled={saving || (!isEdit && !selectedProduct)}>
              {saving ? <><span className="spinner-border spinner-border-sm me-1" />Saving...</> : isEdit ? 'Save Changes' : 'Add Campaign'}
            </button>
            <button className="btn btn-outline-secondary btn-sm" onClick={onClose}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ────────────────────────────────────────────────────────────────
export default function ProductCampaignsPage() {
  const { user, profile } = useAuth();
  const currentUser = user ? { uid: user.id, email: user.email, displayName: profile?.display_name || '' } : null;
  const userRole = profile?.role || '';
  const apcProfile = (userRole === 'apc' || userRole === 'ipc') ? { userName: profile?.display_name || '' } : null;

  const { brands: ctxBrands } = useBrands();
  const brands = useMemo(
    () => (ctxBrands || []).map(b => ({ id: b.id, name: b.brandName || b.brand_name || 'Untitled' })),
    [ctxBrands],
  );
  const [products, setProducts] = useState([]); // { ...productData, _brandId, _brandName }
  const [loading, setLoading] = useState(true);
  const [filterBrand, setFilterBrand] = useState('');
  const [filterType, setFilterType] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editProduct, setEditProduct] = useState(null);
  const [selectedBrand, setSelectedBrand] = useState(null);

  const isApc = userRole === 'apc' || userRole === 'ipc';

  // Stable primitives for the effect deps (objects rebuilt every render
  // would cause the effect to re-run forever, never settling).
  const _uid = user?.id || null;
  const brandIdsKey = useMemo(
    () => (brands || []).map(b => b.id).sort().join(','),
    [brands],
  );

  // Reusable loader so realtime + actions can call it
  const refetch = React.useCallback(async () => {
    try {
      const brandIds = (userRole === 'boss' || userRole === 'ol' || userRole === 'developer')
        ? null
        : new Set((brands || []).map(b => b.id));
      const rows = await listAllProductCampaigns({ brandIds });
      setProducts(rows.map(r => ({ ...r, _brandId: r.brandId, _brandName: r.brandName || '' })));
    } catch { /* ignore */ }
    setLoading(false);
  }, [userRole, brandIdsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!_uid) return;
    let cancelled = false;
    refetch();
    // Realtime: any insert/update/delete on product_campaigns triggers a refetch.
    const channel = supabase
      .channel(`product-campaigns-page-${Math.random().toString(36).slice(2, 8)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'product_campaigns' },
        () => { if (!cancelled) refetch(); })
      .subscribe();
    return () => { cancelled = true; supabase.removeChannel(channel); };
  }, [_uid, refetch]);

  // Auto-expire promotions
  useEffect(() => {
    const now = new Date(); now.setHours(0, 0, 0, 0);
    products.forEach(p => {
      let changed = false;
      const updated = (p.promotions || []).map(promo => {
        if (promo.status === 'active' && promo.endDate) {
          // Parse as local date to avoid timezone issues
          const [y, m, d] = promo.endDate.split('-').map(Number);
          const end = new Date(y, m - 1, d); end.setHours(23, 59, 59, 999);
          if (now > end) { changed = true; return { ...promo, status: 'expired' }; }
        }
        return promo;
      });
      if (changed) {
        // Persist via the v1-compat shim (no-op on brand_products; updates product_campaigns)
        updatePromotionStatuses(p.id, updated).catch(() => {});
      }
    });
  }, [products]);

  const filtered = useMemo(() => {
    return products.filter(p => {
      if (filterBrand && p._brandId !== filterBrand) return false;
      if (filterType && p.type !== filterType) return false;
      if (filterStatus) {
        const hasActive = (p.promotions || []).some(pr => pr.status === 'active');
        if (filterStatus === 'active' && !hasActive) return false;
        if (filterStatus === 'expired' && hasActive) return false;
        if (filterStatus === 'no_promo') return false;
        if (filterStatus === 'ending_soon') {
          const hasEndingSoon = (p.promotions || []).some(pr => {
            if (pr.status !== 'active' || !pr.endDate) return false;
            const d = daysUntil(pr.endDate);
            return d >= 0 && d <= 3;
          });
          if (!hasEndingSoon) return false;
        }
      }
      if (search) {
        const q = search.toLowerCase();
        if (!(p.productName || '').toLowerCase().includes(q) && !(p.productId || '').toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [products, filterBrand, filterType, filterStatus, search]);

  function openAdd() {
    if (brands.length === 1) {
      setSelectedBrand(brands[0]);
      setEditProduct(null);
      setShowModal(true);
    } else if (filterBrand) {
      setSelectedBrand(brands.find(b => b.id === filterBrand) || brands[0]);
      setEditProduct(null);
      setShowModal(true);
    } else {
      setSelectedBrand(null);
      setShowModal(true);
    }
  }

  function openEdit(product) {
    setSelectedBrand({ id: product._brandId, name: product._brandName });
    setEditProduct(product);
    setShowModal(true);
  }

  async function handleDelete(product) {
    if (!window.confirm(`Remove campaign for "${product.productName}"? The product itself will remain in the brand.`)) return;
    await removeProductCampaign(product.id).catch(() => {});
    setProducts(prev => prev.filter(p => !(p.id === product.id && p._brandId === product._brandId)));
  }

  return (
    <div>
      <div className="d-flex align-items-center justify-content-between mb-4">
        <div>
          <h4 className="fw-bold mb-1" style={{ color: '#1e293b' }}>Product Campaigns</h4>
          <p className="text-muted small mb-0">{products.length} campaign{products.length !== 1 ? 's' : ''} across {brands.length} brand{brands.length !== 1 ? 's' : ''}</p>
        </div>
        <button className="btn btn-dark btn-sm d-inline-flex align-items-center gap-1" onClick={openAdd}>
          <i className="bi bi-plus-lg" /> Add Campaign
        </button>
      </div>

      {/* Filters */}
      {products.length > 0 && (
        <div className="card border-0 shadow-sm mb-3" style={{ borderRadius: 12 }}>
          <div className="card-body p-3">
            <div className="d-flex flex-wrap gap-2 align-items-center">
              <div className="position-relative" style={{ flex: '1 1 180px', minWidth: 160 }}>
                <i className="bi bi-search position-absolute text-muted" style={{ left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: '0.78rem', pointerEvents: 'none' }} />
                <input type="text" className="form-control form-control-sm" placeholder="Search products..."
                  style={{ paddingLeft: 30, borderRadius: 8 }} value={search} onChange={e => setSearch(e.target.value)} />
              </div>
              <select className="form-select form-select-sm" style={{ borderRadius: 8, width: 'auto', minWidth: 140 }}
                value={filterBrand} onChange={e => setFilterBrand(e.target.value)}>
                <option value="">All Brands</option>
                {brands.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
              <select className="form-select form-select-sm" style={{ borderRadius: 8, width: 'auto', minWidth: 120 }}
                value={filterType} onChange={e => setFilterType(e.target.value)}>
                <option value="">All Types</option>
                <option value="focus">Focus</option>
                <option value="non-focus">Non-Focus</option>
              </select>
              <select className="form-select form-select-sm" style={{ borderRadius: 8, width: 'auto', minWidth: 130 }}
                value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
                <option value="">All Status</option>
                <option value="active">Active Promos</option>
                <option value="ending_soon">Ending Soon</option>
                <option value="expired">All Expired</option>
              </select>
              {(search || filterBrand || filterType || filterStatus) && (
                <button className="btn btn-sm btn-outline-secondary" style={{ borderRadius: 8, fontSize: '0.75rem' }}
                  onClick={() => { setSearch(''); setFilterBrand(''); setFilterType(''); setFilterStatus(''); }}>
                  <i className="bi bi-x-circle me-1" /> Clear
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Product cards */}
      {loading ? (
        <div className="text-muted small d-flex align-items-center gap-2 py-5 justify-content-center">
          <span className="spinner-border spinner-border-sm" /> Loading...
        </div>
      ) : products.length === 0 ? (
        <div className="text-center py-5" style={{ border: '2px dashed #dee2e6', borderRadius: 12 }}>
          <i className="bi bi-megaphone" style={{ fontSize: '2.5rem', color: '#cbd5e1' }} />
          <p className="fw-semibold text-dark mt-3 mb-1">No campaigns yet</p>
          <p className="text-muted small mb-3">Add your first product campaign to track promotions and expiry dates.</p>
          <button className="btn btn-dark btn-sm" onClick={openAdd}>Add Campaign</button>
        </div>
      ) : (
        <div className="row g-3">
          {filtered.map(p => {
            const activePromos = (p.promotions || []).filter(pr => pr.status === 'active');
            const expiredPromos = (p.promotions || []).filter(pr => pr.status === 'expired');
            const finalPrice = computeFinalPrice(p);
            const soonestEnd = activePromos.reduce((min, pr) => {
              const d = daysUntil(pr.endDate);
              return d < min ? d : min;
            }, Infinity);
            const urgent = soonestEnd <= 2 && soonestEnd >= 0;

            return (
              <div key={`${p._brandId}-${p.id}`} className="col-md-6 col-lg-4">
                <div className="card border-0 shadow-sm h-100" style={{ borderRadius: 14, overflow: 'hidden' }}>
                  <div style={{ height: 4, background: urgent ? '#ef4444' : activePromos.length > 0 ? '#22c55e' : '#94a3b8' }} />
                  <div className="card-body p-4">
                    {/* Header */}
                    <div className="d-flex align-items-start justify-content-between mb-2">
                      <div style={{ minWidth: 0 }}>
                        <div className="fw-bold text-truncate" style={{ fontSize: '0.92rem' }}>{p.productName}</div>
                        <div className="text-muted" style={{ fontSize: '0.7rem' }}>{p._brandName}</div>
                        {p.addedByName && (
                          <div className="d-inline-flex align-items-center gap-1 mt-1" style={{ fontSize: '0.62rem', color: '#64748b' }}>
                            <i className="bi bi-person-circle" />
                            <span>Added by <span className="fw-medium">{p.addedByName}</span></span>
                            {p.addedByRole && (
                              <span className="badge bg-light text-muted border" style={{ fontSize: '0.54rem', padding: '1px 4px' }}>
                                {p.addedByRole.toUpperCase()}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="dropdown">
                        <button className="btn btn-sm btn-light border-0 px-2" data-bs-toggle="dropdown">&hellip;</button>
                        <ul className="dropdown-menu dropdown-menu-end shadow-sm border-0">
                          <li><button className="dropdown-item small" onClick={() => openEdit(p)}><i className="bi bi-pencil me-2" />Edit</button></li>
                          <li><hr className="dropdown-divider my-1" /></li>
                          <li><button className="dropdown-item small text-danger" onClick={() => handleDelete(p)}><i className="bi bi-trash me-2" />Remove Campaign</button></li>
                        </ul>
                      </div>
                    </div>

                    {/* Badges */}
                    <div className="d-flex gap-1 flex-wrap mb-3">
                      <span className="badge rounded-pill" style={{ background: p.type === 'focus' ? '#fef3c7' : '#f3f4f6', color: p.type === 'focus' ? '#92400e' : '#6c757d', fontSize: '0.62rem' }}>
                        {p.type === 'focus' ? 'Focus' : 'Non-Focus'}
                      </span>
                      {p.productId && (
                        <span className="badge rounded-pill bg-light text-muted border" style={{ fontSize: '0.6rem' }}>ID: {p.productId}</span>
                      )}
                      {(p.skus || []).length > 0 && (
                        <span className="badge rounded-pill" style={{ background: '#eef2ff', color: '#4338ca', fontSize: '0.62rem', border: '1px solid #c7d2fe' }}>
                          <i className="bi bi-stack me-1" />{p.skus.length} SKU{p.skus.length !== 1 ? 's' : ''}
                        </span>
                      )}
                      {urgent && (
                        <span className="badge rounded-pill" style={{ background: '#fff0f0', color: '#dc3545', fontSize: '0.62rem', border: '1px solid #fecaca' }}>
                          <i className="bi bi-exclamation-triangle me-1" />{soonestEnd <= 0 ? 'Expired' : `${soonestEnd}d left`}
                        </span>
                      )}
                    </div>

                    {/* Prices */}
                    <div className="d-flex align-items-end gap-2 mb-3">
                      <div>
                        <div className="text-muted" style={{ fontSize: '0.62rem', fontWeight: 600 }}>RETAIL</div>
                        <div className="text-muted" style={{ fontSize: '0.85rem', textDecoration: activePromos.length > 0 ? 'line-through' : 'none' }}>
                          ${(p.retailPrice || 0).toFixed(2)}
                        </div>
                      </div>
                      {activePromos.length > 0 && (
                        <div>
                          <div style={{ fontSize: '0.62rem', fontWeight: 600, color: '#198754' }}>CURRENT</div>
                          <div className="fw-bold" style={{ fontSize: '1.1rem', color: '#198754' }}>${finalPrice.toFixed(2)}</div>
                        </div>
                      )}
                    </div>

                    {/* Promotions list */}
                    {(p.promotions || []).map((pr, i) => {
                      const cfg = getPromoCfg(pr.type);
                      const isExpired = pr.status === 'expired';
                      const days = daysUntil(pr.endDate);
                      return (
                        <div key={i} className="d-flex align-items-center gap-2 rounded-2 p-2 mb-1"
                          style={{ background: isExpired ? '#f3f4f6' : cfg.bg, opacity: isExpired ? 0.5 : 1, fontSize: '0.75rem' }}>
                          <i className={`bi ${cfg.icon}`} style={{ color: cfg.color, fontSize: '0.7rem' }} />
                          <div className="flex-grow-1" style={{ minWidth: 0 }}>
                            <div className="fw-medium text-truncate" style={{ color: isExpired ? '#6c757d' : cfg.color }}>
                              {pr.name || cfg.label}
                            </div>
                            {pr.endDate && (
                              <div className="text-muted" style={{ fontSize: '0.65rem' }}>
                                Ends {pr.endDate} {!isExpired && days <= 2 && days >= 0 && <span className="text-danger fw-bold">({days}d left!)</span>}
                              </div>
                            )}
                          </div>
                          <span className="fw-bold flex-shrink-0" style={{ color: isExpired ? '#6c757d' : '#dc3545' }}>
                            −${(pr.discount || 0).toFixed(2)}
                          </span>
                        </div>
                      );
                    })}

                    {(p.promotions || []).length === 0 && (
                      <p className="text-muted small mb-0">No promotions</p>
                    )}

                    {/* SKU variants — each with its own final price */}
                    {(p.skus || []).length > 0 && (
                      <div className="mt-3 pt-3" style={{ borderTop: '1px dashed #e2e8f0' }}>
                        <div className="d-flex align-items-center gap-1 mb-2">
                          <i className="bi bi-stack" style={{ fontSize: '0.7rem', color: '#4338ca' }} />
                          <span className="fw-semibold text-muted text-uppercase" style={{ fontSize: '0.6rem', letterSpacing: '0.06em' }}>
                            SKU Variants
                          </span>
                        </div>
                        {(p.skus || []).map(s => {
                          const sFinal = computeSkuFinalPrice(p.promotions, s);
                          const hasActive = (p.promotions || []).some(pr => pr.status === 'active');
                          return (
                            <div key={s.id} className="d-flex align-items-center justify-content-between rounded-2 px-2 py-1 mb-1"
                              style={{ background: '#f8fafc', border: '1px solid #e2e8f0' }}>
                              <div className="text-truncate" style={{ minWidth: 0, fontSize: '0.75rem', fontWeight: 500 }}>
                                {s.skuName || 'Unnamed SKU'}
                              </div>
                              <div className="d-flex align-items-baseline gap-2 flex-shrink-0">
                                <span className="text-muted" style={{ fontSize: '0.68rem', textDecoration: hasActive ? 'line-through' : 'none' }}>
                                  ${(s.retailPrice || 0).toFixed(2)}
                                </span>
                                {hasActive && (
                                  <span className="fw-bold" style={{ fontSize: '0.82rem', color: '#198754' }}>
                                    ${sFinal.toFixed(2)}
                                  </span>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Modal */}
      {showModal && (
        selectedBrand ? (
          <CampaignModal
            editProduct={editProduct}
            brandId={selectedBrand.id}
            brandName={selectedBrand.name}
            onClose={() => { setShowModal(false); setEditProduct(null); }}
            onSaved={p => {
              if (editProduct) {
                setProducts(prev => prev.map(x => (x.id === p.id && x._brandId === selectedBrand.id) ? { ...x, ...p, _brandId: selectedBrand.id, _brandName: selectedBrand.name } : x));
              } else {
                setProducts(prev => [{ ...p, _brandId: selectedBrand.id, _brandName: selectedBrand.name }, ...prev]);
              }
              setShowModal(false); setEditProduct(null);
            }}
          />
        ) : (
          /* Brand picker if no brand selected */
          <BrandPickerModal
            brands={brands}
            onPick={(b) => setSelectedBrand(b)}
            onClose={() => setShowModal(false)}
          />
        )
      )}
    </div>
  );
}

// ── Brand picker (used when adding a campaign without a pre-selected brand) ─
function BrandPickerModal({ brands, onPick, onClose }) {
  const [q, setQ] = useState('');
  const filtered = useMemo(
    () => brands.filter(b => !q || (b.name || '').toLowerCase().includes(q.toLowerCase())),
    [brands, q]
  );
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1070, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)' }} onClick={onClose} />
      <div className="card border-0 shadow-lg"
        style={{ position: 'relative', width: '100%', maxWidth: 380, zIndex: 1, borderRadius: 14, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
        <div className="card-header bg-white border-0 pt-4 pb-2 px-4 d-flex align-items-center justify-content-between" style={{ borderRadius: '14px 14px 0 0', flexShrink: 0 }}>
          <h6 className="fw-bold mb-0">Select Brand</h6>
          <button className="btn btn-sm btn-light border-0 px-2" onClick={onClose}><i className="bi bi-x-lg" /></button>
        </div>
        <div className="px-4 pb-2 pt-1" style={{ flexShrink: 0 }}>
          <div className="position-relative">
            <i className="bi bi-search position-absolute text-muted" style={{ left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: '0.78rem', pointerEvents: 'none' }} />
            <input type="text" className="form-control form-control-sm" placeholder="Search brands…"
              style={{ paddingLeft: 30, borderRadius: 8 }}
              value={q} onChange={e => setQ(e.target.value)} autoFocus />
          </div>
        </div>
        <div className="px-4 pb-4 pt-2 d-flex flex-column gap-2" style={{ overflowY: 'auto' }}>
          {filtered.length === 0 ? (
            <p className="text-muted small text-center mb-0 py-3">No brands match.</p>
          ) : filtered.map(b => (
            <button key={b.id} className="btn btn-sm btn-outline-dark text-start" onClick={() => onPick(b)}>
              <i className="bi bi-shop me-2" />{b.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
