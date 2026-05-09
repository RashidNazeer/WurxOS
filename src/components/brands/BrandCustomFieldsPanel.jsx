import { useEffect, useState } from 'react';
import {
  listBrandCustomFields, addBrandCustomField,
  updateBrandCustomField, deleteBrandCustomField,
} from '../../lib/brandsApi';
import { PlusIcon, XIcon, AlertIcon, PencilIcon, CheckIcon } from '../common/Icon';

/**
 * Inline editor for a brand's free-form custom fields. Reads + writes hit
 * Supabase directly (RLS enforces edit rights).
 */
export default function BrandCustomFieldsPanel({ brandId, canEdit }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [newKey, setNewKey] = useState('');
  const [newVal, setNewVal] = useState('');
  const [editId, setEditId] = useState(null);
  const [editVal, setEditVal] = useState('');

  async function load() {
    setLoading(true); setErr('');
    try { setRows(await listBrandCustomFields(brandId)); }
    catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, [brandId]);

  async function add(e) {
    e.preventDefault();
    if (!newKey.trim()) return;
    setErr('');
    try {
      await addBrandCustomField(brandId, newKey, newVal);
      setNewKey(''); setNewVal('');
      load();
    } catch (e) { setErr(e.message); }
  }

  async function saveVal(id) {
    try {
      await updateBrandCustomField(id, { fieldValue: editVal });
      setEditId(null);
      load();
    } catch (e) { setErr(e.message); }
  }

  async function del(id) {
    if (!confirm('Delete this custom field?')) return;
    try { await deleteBrandCustomField(id); load(); }
    catch (e) { setErr(e.message); }
  }

  return (
    <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border-subtle)' }}>
      <div style={{
        fontSize: 11.5, fontWeight: 700, color: 'var(--text-muted)',
        textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10,
      }}>
        Custom fields
      </div>

      {err && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 10 }}>
          <AlertIcon width="14" height="14" /> <span>{err}</span>
        </div>
      )}

      {loading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          <span className="wx-spinner" /> Loading…
        </div>
      ) : rows.length === 0 ? (
        <div style={{
          border: '1px dashed var(--border-default)', padding: '10px 12px',
          borderRadius: 'var(--radius-md)', color: 'var(--text-muted)', fontSize: 12.5, marginBottom: 10,
        }}>
          No custom fields yet.{canEdit && ' Add one below.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
          {rows.map((r) => (
            <div key={r.id} style={{
              display: 'grid', gridTemplateColumns: '160px 1fr auto',
              gap: 8, alignItems: 'center',
              padding: '8px 10px',
              background: 'var(--surface-2)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-md)',
            }}>
              <div style={{ fontWeight: 600, fontSize: 12.5, color: 'var(--text-primary)' }}>
                {r.field_name}
              </div>
              {editId === r.id ? (
                <input
                  className="wx-input"
                  value={editVal}
                  onChange={(e) => setEditVal(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && saveVal(r.id)}
                  autoFocus
                  style={{ padding: '5px 8px', fontSize: 12.5 }}
                />
              ) : (
                <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', wordBreak: 'break-word' }}>
                  {r.field_value || <span style={{ color: 'var(--text-muted)' }}>—</span>}
                </div>
              )}
              {canEdit && (
                <div style={{ display: 'flex', gap: 4 }}>
                  {editId === r.id ? (
                    <>
                      <button className="wx-btn wx-btn-primary" style={{ padding: '4px 8px', fontSize: 11 }} onClick={() => saveVal(r.id)}>
                        <CheckIcon width="12" height="12" />
                      </button>
                      <button className="wx-btn wx-btn-ghost" style={{ padding: '4px 8px', fontSize: 11 }} onClick={() => setEditId(null)}>
                        <XIcon width="12" height="12" />
                      </button>
                    </>
                  ) : (
                    <>
                      <button title="Edit value" onClick={() => { setEditId(r.id); setEditVal(r.field_value || ''); }}
                        style={{ border: 0, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', padding: 4 }}>
                        <PencilIcon width="13" height="13" />
                      </button>
                      <button title="Delete" onClick={() => del(r.id)}
                        style={{ border: 0, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', padding: 4 }}>
                        <XIcon width="13" height="13" />
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {canEdit && (
        <form onSubmit={add} style={{ display: 'grid', gridTemplateColumns: '160px 1fr auto', gap: 6 }}>
          <input className="wx-input" placeholder="Field name"
            value={newKey} onChange={(e) => setNewKey(e.target.value)}
            style={{ padding: '7px 10px', fontSize: 12.5 }}
          />
          <input className="wx-input" placeholder="Value"
            value={newVal} onChange={(e) => setNewVal(e.target.value)}
            style={{ padding: '7px 10px', fontSize: 12.5 }}
          />
          <button type="submit" className="wx-btn wx-btn-primary" disabled={!newKey.trim()}>
            <PlusIcon width="13" height="13" /> Add
          </button>
        </form>
      )}
    </div>
  );
}
