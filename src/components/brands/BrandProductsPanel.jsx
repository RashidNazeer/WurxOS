import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  listProducts, createProduct, updateProduct, deleteProduct,
} from '../../lib/productsApi';
import {
  PlusIcon, AlertIcon, RefreshIcon, XIcon, CheckIcon, TrashIcon,
  PencilIcon, BoxIcon, LinkIcon,
} from '../common/Icon';
import '../../styles/table.css';
import '../../styles/modal.css';

export default function BrandProductsPanel({ brandId, canEdit }) {
  const qc = useQueryClient();
  const { data: rows = [], isLoading, error } = useQuery({
    queryKey: ['brand-products', brandId],
    queryFn:  () => listProducts(brandId),
    enabled:  !!brandId,
  });

  const [editRow, setEdit] = useState(null);
  const load = () => qc.invalidateQueries({ queryKey: ['brand-products', brandId] });

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 800 }}>Products</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 2 }}>
            TikTok Shop products sold on this brand. Campaigns attach to a product.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="wx-btn wx-btn-ghost" onClick={load} title="Refresh">
            <RefreshIcon width="14" height="14" />
          </button>
          {canEdit && (
            <button className="wx-btn wx-btn-primary" onClick={() => setEdit({})}>
              <PlusIcon width="14" height="14" /> Add product
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 12 }}>
          <AlertIcon width="14" height="14" /> <span>{error.message}</span>
        </div>
      )}

      {isLoading ? (
        <div className="wx-empty"><span className="wx-spinner" /> Loading products…</div>
      ) : rows.length === 0 ? (
        <div className="wx-empty">
          <div style={{ display: 'grid', placeItems: 'center', width: 48, height: 48, borderRadius: '50%', background: 'var(--surface-2)', color: 'var(--text-muted)', margin: '0 auto 10px' }}>
            <BoxIcon width="20" height="20" />
          </div>
          <div className="wx-empty-title">No products yet</div>
          <div>{canEdit ? 'Click Add product to list one.' : 'Products added by this brand\'s team will show here.'}</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
          {rows.map((r) => (
            <ProductCard
              key={r.id}
              row={r}
              canEdit={canEdit}
              onEdit={() => setEdit(r)}
              onDelete={async () => {
                if (!confirm(`Delete "${r.product_name}"? This also removes any campaigns on it.`)) return;
                try { await deleteProduct(r.id); load(); } catch (e) { alert(e.message); }
              }}
            />
          ))}
        </div>
      )}

      {editRow && (
        <ProductEditModal
          brandId={brandId}
          product={editRow}
          onClose={() => setEdit(null)}
          onSaved={() => { setEdit(null); load(); }}
        />
      )}
    </>
  );
}

function ProductCard({ row, canEdit, onEdit, onDelete }) {
  const skuCount = (row.skus || []).length;
  return (
    <div className="wx-card" style={{ padding: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 6 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 10.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'flex', alignItems: 'center', gap: 6 }}>
            {row.type === 'focus' ? 'Focus' : 'Non-focus'}
            {row.product_id && <span style={{ color: 'var(--text-muted)', fontWeight: 400, letterSpacing: 0, textTransform: 'none' }}>· ID {row.product_id}</span>}
          </div>
          <div style={{ fontWeight: 700, fontSize: 14, marginTop: 3 }}>{row.product_name}</div>
        </div>
        {canEdit && (
          <div style={{ display: 'flex', gap: 2 }}>
            <button onClick={onEdit} style={{ border: 0, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', padding: 4 }} title="Edit">
              <PencilIcon width="13" height="13" />
            </button>
            <button onClick={onDelete} style={{ border: 0, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', padding: 4 }} title="Delete">
              <TrashIcon width="13" height="13" />
            </button>
          </div>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
        <Mini label="Retail" value={`$${Number(row.retail_price || 0).toFixed(2)}`} />
        <Mini label="SKUs"   value={skuCount > 0 ? skuCount : 'None'} />
      </div>
      {row.product_url && (
        <a href={row.product_url} target="_blank" rel="noreferrer"
           style={{ fontSize: 11.5, color: 'var(--accent)', marginTop: 8, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <LinkIcon width="11" height="11" /> Open on TikTok Shop
        </a>
      )}
    </div>
  );
}

function Mini({ label, value }) {
  return (
    <div style={{ padding: 8, background: 'var(--surface-1)', border: '1px solid var(--border-subtle)', borderRadius: 8 }}>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 800, marginTop: 2 }}>{value}</div>
    </div>
  );
}

// ============================================================
// Edit modal — product + SKU editor
// ============================================================
function ProductEditModal({ brandId, product, onClose, onSaved }) {
  const isNew = !product.id;

  const [productName, setName] = useState(product.product_name || '');
  const [productId, setPid]    = useState(product.product_id   || '');
  const [productUrl, setPurl]  = useState(product.product_url  || '');
  const [type, setType]        = useState(product.type || 'focus');
  const [retailPrice, setRP]   = useState(
    product.retail_price != null ? String(product.retail_price) : '',
  );
  const [skus, setSkus] = useState(
    (product.skus || []).length
      ? product.skus.map((s) => ({ id: s.id, sku_name: s.sku_name, retail_price: s.retail_price }))
      : [],
  );
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  function addSku() {
    setSkus((cur) => [...cur, { id: 'sku_' + Math.random().toString(36).slice(2, 8), sku_name: '', retail_price: retailPrice || 0 }]);
  }
  function updateSku(id, field, value) {
    setSkus((cur) => cur.map((s) => s.id === id ? { ...s, [field]: value } : s));
  }
  function removeSku(id) {
    setSkus((cur) => cur.filter((s) => s.id !== id));
  }

  async function save() {
    setErr('');
    if (!productName.trim()) return setErr('Product name is required.');
    setSaving(true);
    try {
      const payload = {
        productName,
        productId:   productId  || null,
        productUrl:  productUrl || null,
        type,
        retailPrice: Number(retailPrice || 0),
        skus,
      };
      if (isNew) await createProduct({ brandId, ...payload });
      else       await updateProduct(product.id, {
        product_name: payload.productName,
        product_id:   payload.productId,
        product_url:  payload.productUrl,
        type:         payload.type,
        retail_price: payload.retailPrice,
        skus:         payload.skus,
      });
      onSaved();
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  }

  return (
    <div className="wx-modal-backdrop wx-m-backdrop" onClick={onClose}>
      <div className="wx-modal" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
        <div className="wx-m-head">
          <div className="wx-m-head-icon"><BoxIcon width="18" height="18" /></div>
          <div className="wx-m-head-text">
            <div className="wx-m-head-title">{isNew ? 'Add product' : 'Edit product'}</div>
            <div className="wx-m-head-sub">List the product first — campaigns attach to it later.</div>
          </div>
          <button type="button" className="wx-m-head-close" onClick={onClose}><XIcon width="14" height="14" /></button>
        </div>

        <div className="wx-m-body">
          {err && <div className="wx-alert wx-alert-danger"><AlertIcon width="14" height="14" /> <span>{err}</span></div>}

          <div className="wx-m-field">
            <div className="wx-m-field-head">
              <div className="wx-m-field-label">Product name</div>
              <div className="wx-m-field-meta is-required">Required</div>
            </div>
            <input className="wx-m-input" value={productName} onChange={(e) => setName(e.target.value)}
              autoFocus placeholder="e.g. Glow Skin Glam Bites" />
          </div>

          <div className="wx-m-field">
            <div className="wx-m-field-head">
              <div className="wx-m-field-label">TikTok Shop product ID</div>
              <div className="wx-m-field-meta">Optional</div>
            </div>
            <input className="wx-m-input" value={productId} onChange={(e) => setPid(e.target.value)} />
          </div>

          <div className="wx-m-field">
            <div className="wx-m-field-head">
              <div className="wx-m-field-label">Product URL</div>
              <div className="wx-m-field-meta">Optional</div>
            </div>
            <div className="wx-m-input-shell">
              <div className="wx-m-input-prefix">https://</div>
              <input
                value={productUrl.replace(/^https?:\/\//i, '')}
                onChange={(e) => setPurl(e.target.value ? 'https://' + e.target.value.replace(/^https?:\/\//i, '') : '')}
                placeholder="shop.tiktok.com/view/product/…"
              />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div className="wx-m-field">
              <div className="wx-m-field-head">
                <div className="wx-m-field-label">Retail price ($)</div>
              </div>
              <input type="number" step="0.01" min="0" className="wx-m-input"
                value={retailPrice} onChange={(e) => setRP(e.target.value)}
                placeholder="24.99" />
            </div>
            <div className="wx-m-field">
              <div className="wx-m-field-head">
                <div className="wx-m-field-label">Type</div>
              </div>
              <div className="wx-m-cards" data-cols="2">
                {['focus','non-focus'].map((t) => (
                  <button key={t} type="button"
                    className={`wx-m-card ${type === t ? 'is-active' : ''}`}
                    onClick={() => setType(t)}>
                    <div className="wx-m-card-main">
                      <div className="wx-m-card-title" style={{ fontSize: 12 }}>{t === 'focus' ? 'Focus' : 'Non-focus'}</div>
                    </div>
                    <span className="wx-m-card-check"><CheckIcon width="10" height="10" /></span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="wx-m-field">
            <div className="wx-m-field-head">
              <div className="wx-m-field-label">SKUs</div>
              <div className="wx-m-field-meta">{skus.length === 0 ? 'Optional — no variants' : `${skus.length} variant${skus.length === 1 ? '' : 's'}`}</div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {skus.map((s) => (
                <div key={s.id} style={{ display: 'grid', gridTemplateColumns: '1fr 110px auto', gap: 6 }}>
                  <input className="wx-m-input" placeholder="SKU name (e.g. 30-count jar)"
                    value={s.sku_name} onChange={(e) => updateSku(s.id, 'sku_name', e.target.value)} />
                  <input type="number" step="0.01" className="wx-m-input" placeholder="Price"
                    value={s.retail_price} onChange={(e) => updateSku(s.id, 'retail_price', e.target.value)} />
                  <button type="button" className="wx-btn wx-btn-ghost" onClick={() => removeSku(s.id)} aria-label="Remove">
                    <XIcon width="13" height="13" />
                  </button>
                </div>
              ))}
              <button type="button" className="wx-btn wx-btn-ghost" onClick={addSku} style={{ alignSelf: 'flex-start' }}>
                <PlusIcon width="13" height="13" /> Add SKU
              </button>
            </div>
          </div>
        </div>

        <div className="wx-m-foot">
          <div className="wx-m-kbd-hints"><kbd>Esc</kbd> cancel</div>
          <div className="wx-m-foot-actions">
            <button className="wx-btn wx-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="wx-btn wx-btn-primary" onClick={save} disabled={saving}>
              {saving ? <><span className="wx-spinner" /> Saving…</> : <><CheckIcon width="14" height="14" /> {isNew ? 'Add' : 'Save'}</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
