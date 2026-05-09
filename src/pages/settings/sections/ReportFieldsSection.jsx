import { useEffect, useState } from 'react';
import { useAuth } from '../../../contexts/AuthContext';
import {
  listUserCustomFields, addCustomField, renameCustomField, deleteCustomField,
} from '../../../lib/reportsApi';
import {
  ReportIcon, AlertIcon, PlusIcon, PencilIcon, XIcon,
} from '../../../components/common/Icon';
import SectionShell from './SectionShell';

export default function ReportFieldsSection() {
  const { user } = useAuth();
  const userId = user?.id;

  const [fields, setFields] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editingName, setEditingName] = useState('');

  function load() {
    if (!userId) return;
    setLoading(true);
    listUserCustomFields(userId)
      .then((f) => setFields(f))
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }
  useEffect(load, [userId]);

  async function handleAdd(e) {
    e.preventDefault();
    if (!newName.trim()) return;
    try { setErr(''); await addCustomField(userId, newName); setNewName(''); load(); }
    catch (e) { setErr(e.message); }
  }
  async function handleRename(id) {
    if (!editingName.trim()) { setEditingId(null); return; }
    try { await renameCustomField(id, editingName); setEditingId(null); setEditingName(''); load(); }
    catch (e) { setErr(e.message); }
  }
  async function handleDelete(id) {
    if (!confirm('Delete this custom field? It stays visible on historical reports that already have a value.')) return;
    try { await deleteCustomField(id); load(); }
    catch (e) { setErr(e.message); }
  }

  return (
    <SectionShell
      icon={ReportIcon}
      title="Report custom fields"
      subtitle="Your own template — any fields you add here show up as extra sections on the reports you author."
    >
      {err && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 10 }}>
          <AlertIcon width="14" height="14" /> <span>{err}</span>
        </div>
      )}

      {loading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          <span className="wx-spinner" style={{ color: 'var(--accent)' }} /> Loading…
        </div>
      ) : (
        <>
          {fields.length === 0 && (
            <div style={{
              border: '1px dashed var(--border-default)',
              padding: '12px 14px',
              borderRadius: 'var(--radius-md)',
              color: 'var(--text-muted)',
              fontSize: 13, marginBottom: 10,
            }}>
              No custom fields yet. Add one below.
            </div>
          )}
          {fields.map((f) => (
            <div key={f.id} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '8px 10px',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-md)',
              background: 'var(--surface-2)',
              marginBottom: 6,
            }}>
              {editingId === f.id ? (
                <>
                  <input
                    className="wx-input"
                    value={editingName}
                    onChange={(e) => setEditingName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleRename(f.id)}
                    autoFocus
                    style={{ flex: 1, padding: '7px 10px', fontSize: 13 }}
                  />
                  <button className="wx-btn wx-btn-primary" onClick={() => handleRename(f.id)}
                          style={{ padding: '6px 12px', fontSize: 12 }}>Save</button>
                  <button className="wx-btn wx-btn-ghost" onClick={() => { setEditingId(null); setEditingName(''); }}
                          style={{ padding: '6px 10px', fontSize: 12 }}>Cancel</button>
                </>
              ) : (
                <>
                  <span style={{ flex: 1, color: 'var(--text-primary)', fontWeight: 600, fontSize: 13.5 }}>
                    {f.field_name}
                  </span>
                  <button onClick={() => { setEditingId(f.id); setEditingName(f.field_name); }}
                    style={{ border: 0, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', padding: 6, borderRadius: 'var(--radius-sm)' }}
                    title="Rename">
                    <PencilIcon width="14" height="14" />
                  </button>
                  <button onClick={() => handleDelete(f.id)}
                    style={{ border: 0, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', padding: 6, borderRadius: 'var(--radius-sm)' }}
                    title="Delete">
                    <XIcon width="14" height="14" />
                  </button>
                </>
              )}
            </div>
          ))}
        </>
      )}

      <form onSubmit={handleAdd} style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <input
          className="wx-input"
          placeholder="Add a new field name…"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          style={{ flex: 1 }}
        />
        <button type="submit" className="wx-btn wx-btn-primary" disabled={!newName.trim()}>
          <PlusIcon width="14" height="14" /> Add
        </button>
      </form>
    </SectionShell>
  );
}
