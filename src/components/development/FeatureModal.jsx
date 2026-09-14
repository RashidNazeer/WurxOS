// Create a feature. New features start in "Later" and are planned from the
// roadmap.
import { useState } from 'react';
import { DEV_PRIORITIES, PRIORITY_META, createFeature } from '../../lib/devTasksApi';
import DevModal from './DevModal';

// Matches the dev_feature_name_length_check constraint (migration 361).
const NAME_MAX = 40;

export default function FeatureModal({ products, developers, onClose, onSaved }) {
  const [form, setForm] = useState({
    name: '',
    description: '',
    productId: products[0]?.id || '',
    ownerId: developers[0]?.id || '',
    priority: 'normal',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (key, value) => setForm((old) => ({ ...old, [key]: value }));

  async function save() {
    setBusy(true);
    setError('');
    try {
      if (!form.name.trim()) throw new Error('Feature name is required.');
      await createFeature(form);
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const footer = (
    <>
      <button type="button" className="wx-btn wx-btn-ghost" onClick={onClose}>Cancel</button>
      <button type="button" className="wx-btn wx-btn-primary" disabled={busy} onClick={save}>
        {busy ? 'Creating…' : 'Create in Later'}
      </button>
    </>
  );

  return (
    <DevModal title="New feature" onClose={onClose} footer={footer}>
      <div className="dev-form">
        {error && <div className="wx-alert wx-alert-danger">{error}</div>}

        <label>
          Feature name
          <input
            className="wx-input"
            autoFocus
            maxLength={NAME_MAX}
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="Landing page"
          />
        </label>

        <label>
          Description
          <textarea className="wx-input" rows={3} value={form.description} onChange={(e) => set('description', e.target.value)} />
        </label>

        <div className="dev-form-pair">
          <label>
            Product
            <select className="wx-input" value={form.productId} onChange={(e) => set('productId', e.target.value)}>
              {products.map((product) => <option value={product.id} key={product.id}>{product.name}</option>)}
            </select>
          </label>
          <label>
            Owner
            <select className="wx-input" value={form.ownerId} onChange={(e) => set('ownerId', e.target.value)}>
              {developers.map((person) => <option value={person.id} key={person.id}>{person.display_name}</option>)}
            </select>
          </label>
        </div>

        <label>
          Priority
          <select className="wx-input" value={form.priority} onChange={(e) => set('priority', e.target.value)}>
            {DEV_PRIORITIES.map((priority) => <option value={priority} key={priority}>{PRIORITY_META[priority].label}</option>)}
          </select>
        </label>
      </div>
    </DevModal>
  );
}
