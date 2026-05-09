import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import {
  listBrandsWithAssignedAPCs, createGroupTasks,
} from '../../lib/tasksApi';
import BrandAvatar from '../brands/BrandAvatar';
import { XIcon, AlertIcon, UsersIcon, CheckIcon } from '../common/Icon';

/**
 * TL-only: pick multiple brands, define one task template, fan it out as
 * one task per (brand × assigned APC).
 */
export default function GroupTaskModal({ onClose, onCreated }) {
  const { user } = useAuth();
  const [brands, setBrands]           = useState([]);
  const [loading, setLoading]         = useState(true);
  const [selectedBrandIds, setSel]    = useState([]);
  const [title, setTitle]             = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory]       = useState('general');
  const [priority, setPriority]       = useState('medium');
  const [dueDate, setDueDate]         = useState('');
  const [link, setLink]               = useState('');
  const [saving, setSaving]           = useState(false);
  const [error, setError]             = useState('');

  useEffect(() => {
    let cancelled = false;
    if (!user?.id) return;
    listBrandsWithAssignedAPCs(user.id)
      .then((list) => {
        if (cancelled) return;
        setBrands(list.filter((b) => (b.assignedUsers || []).length > 0));
      })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [user?.id]);

  const pairs = useMemo(() => {
    const out = [];
    for (const b of brands) {
      if (!selectedBrandIds.includes(b.id)) continue;
      for (const apc of b.assignedUsers || []) {
        out.push({ brandId: b.id, assigneeId: apc.id });
      }
    }
    return out;
  }, [brands, selectedBrandIds]);

  const totals = useMemo(() => {
    const uniqueApcs = new Set(pairs.map((p) => p.assigneeId));
    return {
      brands: selectedBrandIds.length,
      tasks: pairs.length,
      apcs: uniqueApcs.size,
    };
  }, [selectedBrandIds, pairs]);

  const toggle = (id) => setSel((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const selectAll = () => setSel(brands.map((b) => b.id));
  const clearAll  = () => setSel([]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!title.trim()) return setError('Title is required.');
    if (!pairs.length) return setError('Select at least one brand with assigned APCs.');

    try {
      setSaving(true);
      await createGroupTasks({
        pairs, title, description, category, priority, dueDate, link,
      });
      onCreated();
    } catch (err) {
      setError(err.message || 'Failed to create group tasks.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
        <form onSubmit={handleSubmit}>
          <div className="wx-modal-header">
            <div className="wx-modal-title">Add group task</div>
            <button type="button" className="shell-icon-btn" onClick={onClose} aria-label="Close">
              <XIcon width="16" height="16" />
            </button>
          </div>

          <div className="wx-modal-body">
            {error && (
              <div className="wx-alert wx-alert-danger" style={{ marginBottom: 12 }}>
                <AlertIcon width="16" height="16" /> <span>{error}</span>
              </div>
            )}
            <div style={{
              fontSize: 13,
              color: 'var(--text-secondary)',
              marginBottom: 14,
            }}>
              Define a single task and fan it out to all APCs assigned to each selected brand.
            </div>

            {/* Brand picker */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <label className="wx-label" style={{ margin: 0 }}>
                  Brands{' '}
                  <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>
                    ({selectedBrandIds.length} of {brands.length} selected)
                  </span>
                </label>
                <div style={{ display: 'flex', gap: 10, fontSize: 12 }}>
                  <button type="button" onClick={selectAll} className="auth-link">Select all</button>
                  <span style={{ color: 'var(--text-muted)' }}>·</span>
                  <button type="button" onClick={clearAll} className="auth-link" style={{ color: 'var(--text-muted)' }}>Clear</button>
                </div>
              </div>

              {loading ? (
                <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                  <span className="wx-spinner" style={{ color: 'var(--accent)' }} /> Loading brands…
                </div>
              ) : brands.length === 0 ? (
                <div style={{
                  border: '1px dashed var(--border-default)',
                  padding: '14px',
                  borderRadius: 'var(--radius-md)',
                  color: 'var(--text-muted)',
                  fontSize: 13,
                }}>
                  No brands have APCs assigned yet. Assign APCs to brands first.
                </div>
              ) : (
                <div style={{
                  maxHeight: 220,
                  overflowY: 'auto',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-md)',
                  padding: 8,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                }}>
                  {brands.map((b) => {
                    const on = selectedBrandIds.includes(b.id);
                    return (
                      <button
                        type="button"
                        key={b.id}
                        onClick={() => toggle(b.id)}
                        disabled={saving}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          padding: '8px 10px',
                          background: on ? 'var(--accent-soft)' : 'transparent',
                          border: `1px solid ${on ? 'var(--accent)' : 'transparent'}`,
                          borderRadius: 'var(--radius-md)',
                          textAlign: 'left',
                          cursor: 'pointer',
                          color: 'inherit',
                        }}
                      >
                        <BrandAvatar brand={b} size={28} radius={6} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: 13 }}>
                            {b.brand_name}
                          </div>
                          <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                            {b.assignedUsers.length} APC{b.assignedUsers.length === 1 ? '' : 's'}
                          </div>
                        </div>
                        {on && <CheckIcon width="15" height="15" style={{ color: 'var(--accent)' }} />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Preview */}
            {totals.brands > 0 && (
              <div style={{
                padding: '10px 14px',
                background: 'var(--accent-soft)',
                color: 'var(--accent)',
                borderRadius: 'var(--radius-md)',
                fontSize: 13,
                marginBottom: 14,
                display: 'flex',
                gap: 16,
                flexWrap: 'wrap',
                fontWeight: 600,
              }}>
                <span>🛍️ {totals.brands} brand{totals.brands === 1 ? '' : 's'}</span>
                <span><UsersIcon width="14" height="14" style={{ verticalAlign: 'middle' }} /> {totals.apcs} APC{totals.apcs === 1 ? '' : 's'}</span>
                <span>📋 {totals.tasks} task{totals.tasks === 1 ? '' : 's'} will be created</span>
              </div>
            )}

            {/* Task fields */}
            <div style={{ marginBottom: 12 }}>
              <label className="wx-label">Title <span style={{ color: 'var(--danger)' }}>*</span></label>
              <input
                className="wx-input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={saving}
                placeholder="e.g. Post daily recap by 6pm"
              />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label className="wx-label">Description</label>
              <textarea
                className="wx-input"
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={saving}
                style={{ resize: 'vertical', minHeight: 60 }}
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 12 }}>
              <div>
                <label className="wx-label">Category</label>
                <select
                  className="wx-input"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  disabled={saving}
                >
                  <option value="general">General</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </div>
              <div>
                <label className="wx-label">Priority</label>
                <div style={{ display: 'flex', gap: 4 }}>
                  {['low','medium','high'].map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setPriority(p)}
                      disabled={saving}
                      className={`wx-role-chip ${priority === p ? 'wx-role-chip-active' : ''}`}
                      style={{ flex: 1, textAlign: 'center', padding: '8px 4px' }}
                    >
                      {p[0].toUpperCase() + p.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <div>
                <label className="wx-label">Due date</label>
                <input type="date" className="wx-input" value={dueDate} onChange={(e) => setDueDate(e.target.value)} disabled={saving} />
              </div>
              <div>
                <label className="wx-label">Link</label>
                <input type="url" className="wx-input" value={link} onChange={(e) => setLink(e.target.value)} disabled={saving} placeholder="https://…" />
              </div>
            </div>
          </div>

          <div className="wx-modal-footer">
            <button type="button" className="wx-btn wx-btn-ghost" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="wx-btn wx-btn-primary" disabled={saving || totals.tasks === 0}>
              {saving
                ? <><span className="wx-spinner" /> Creating {totals.tasks}…</>
                : totals.tasks > 0
                  ? `Create ${totals.tasks} task${totals.tasks === 1 ? '' : 's'}`
                  : 'Create tasks'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
