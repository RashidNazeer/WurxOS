import { useEffect, useState } from 'react';
import RichTextEditor from '../common/RichTextEditor';
import { sanitizeRichHtml } from '../common/RichContent';
import {
  clientSectionAdd, clientSectionRename, clientSectionRemove, clientSectionSetValue,
} from '../../lib/clientReportSectionsApi';
import { supabase } from '../../lib/supabase';

/**
 * Persistent client-added sections for a brand.
 *
 * Mirrors v1's BrandSectionsPanel. The header (template) lives in
 * brand_report_sections.sections (a jsonb array per brand) so it
 * shows up on every report for the brand. Each section's value is
 * stored per-report in report_section_values.
 *
 * Two modes:
 *   * Client mode  (token, !readOnly) — adds/edits via the public
 *                  client_section_* RPCs. Token is the auth gate.
 *   * In-app mode  (no token, readOnly=true) — view only. Boss/TL/
 *                  APC see what the client wrote inline; if they
 *                  want their own custom fields they use the report
 *                  form's existing customFields feature.
 *
 * Props:
 *   brandId          — required
 *   brandName        — for header display
 *   reportId         — required (the report whose values we render)
 *   sections         — array of { id, name, addedAt, addedBy }
 *   sectionValues    — array of { report_id, section_id, section_name, value, updated_at }
 *                      (only those for THIS report; the parent filters)
 *   token            — required when readOnly=false (anonymous client)
 *   readOnly         — true for app users (default false)
 *   onMutate         — () => void; called after a successful mutation so
 *                      the parent can refetch get_client_access
 */
export default function BrandSectionsPanel({
  brandId, brandName, reportId,
  sections: sectionsProp,
  sectionValues: valuesProp,
  token = null, readOnly = false,
  onMutate,
  // When `selfFetch` is true the panel pulls sections+values from
  // Supabase directly using the authenticated user's RLS. This is
  // the in-app path (Boss/TL/APC viewing a report). Client portal
  // passes data via props because it already has it from the
  // get_client_access RPC payload.
  selfFetch = false,
}) {
  const [fetchedSections, setFetchedSections] = useState([]);
  const [fetchedValues, setFetchedValues]     = useState([]);
  const sections      = selfFetch ? fetchedSections : (sectionsProp || []);
  const sectionValues = selfFetch ? fetchedValues   : (valuesProp || []);

  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  // Self-fetch in app mode.
  useEffect(() => {
    if (!selfFetch || !brandId || !reportId) return;
    let cancelled = false;
    (async () => {
      try {
        const [{ data: brsRow }, { data: vals }] = await Promise.all([
          supabase.from('brand_report_sections').select('sections').eq('brand_id', brandId).maybeSingle(),
          supabase.from('report_section_values').select('*').eq('report_id', reportId),
        ]);
        if (cancelled) return;
        setFetchedSections(brsRow?.sections || []);
        setFetchedValues(vals || []);
      } catch { /* swallow — read-only mode, blank panel is fine */ }
    })();
    return () => { cancelled = true; };
  }, [selfFetch, brandId, reportId]);

  // Reset edit state when report or section list changes underneath us.
  useEffect(() => { setEditingId(''); setDraft(''); }, [reportId]);

  const valueFor = (sectionId) => {
    const row = sectionValues.find((v) => v.section_id === sectionId);
    return row ? row.value || '' : '';
  };

  function startEdit(section) {
    setEditingId(section.id);
    setDraft(valueFor(section.id));
    setError('');
  }
  function cancelEdit() {
    setEditingId('');
    setDraft('');
  }

  async function handleSaveValue(section) {
    setBusy('save:' + section.id); setError('');
    try {
      await clientSectionSetValue({
        token, reportId,
        sectionId: section.id, sectionName: section.name,
        value: draft,
      });
      cancelEdit();
      onMutate && onMutate();
    } catch (e) { setError(e.message || 'Save failed.'); }
    finally { setBusy(''); }
  }

  async function handleAdd() {
    const name = newName.trim();
    if (!name) return;
    setBusy('add'); setError('');
    try {
      const created = await clientSectionAdd({ token, brandId, name });
      setNewName('');
      setAdding(false);
      onMutate && onMutate();
      // Auto-open the editor for the new section so client can fill in immediately.
      setEditingId(created.id);
      setDraft('');
    } catch (e) { setError(e.message || 'Add failed.'); }
    finally { setBusy(''); }
  }

  async function handleRename(section) {
    const next = window.prompt('Rename section:', section.name);
    if (next == null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === section.name) return;
    setBusy('rename:' + section.id); setError('');
    try {
      await clientSectionRename({ token, brandId, sectionId: section.id, newName: trimmed });
      onMutate && onMutate();
    } catch (e) { setError(e.message || 'Rename failed.'); }
    finally { setBusy(''); }
  }

  async function handleRemove(section) {
    const ok = window.confirm(
      `Remove section "${section.name}" from ${brandName || 'this brand'}? ` +
      `Past report values will stay but the section will no longer appear here.`,
    );
    if (!ok) return;
    setBusy('remove:' + section.id); setError('');
    try {
      await clientSectionRemove({ token, brandId, sectionId: section.id });
      onMutate && onMutate();
    } catch (e) { setError(e.message || 'Remove failed.'); }
    finally { setBusy(''); }
  }

  // Don't render anything in read-only mode if there's nothing to show.
  if (readOnly && sections.length === 0) return null;

  return (
    <div className="card border-0 shadow-sm mt-4" style={{ borderRadius: 14 }}>
      <div className="card-body p-3">
        <div className="d-flex align-items-center justify-content-between mb-3 flex-wrap gap-2">
          <div>
            <h6 className="fw-bold mb-0 d-flex align-items-center gap-2" style={{ fontSize: '0.95rem' }}>
              <i className="bi bi-pin-angle-fill" style={{ color: '#8b5cf6' }} />
              {brandName ? `${brandName} — Client Sections` : 'Client Sections'}
            </h6>
            <div className="text-muted mt-1" style={{ fontSize: '0.72rem' }}>
              {readOnly ? (
                <>Sections added by the client for <strong>{brandName || 'this brand'}</strong>.</>
              ) : (
                <>Sections you add here stay attached to <strong>{brandName || 'this brand'}</strong>'s reports — fill in a value once per report.</>
              )}
            </div>
          </div>
          {!readOnly && !adding && (
            <button className="btn btn-sm btn-outline-dark d-inline-flex align-items-center gap-1"
              style={{ borderRadius: 8, fontSize: '0.74rem' }}
              onClick={() => { setAdding(true); setNewName(''); setError(''); }}>
              <i className="bi bi-plus-lg" /> Add Section
            </button>
          )}
        </div>

        {error && (
          <div className="alert alert-danger small py-2 px-3 mb-2">
            <i className="bi bi-exclamation-triangle me-1" />{error}
          </div>
        )}

        {!readOnly && adding && (
          <div className="rounded-3 p-3 mb-3" style={{ background: '#f8fafc', border: '1px solid #e2e8f0' }}>
            <label className="form-label small fw-semibold">Section name</label>
            <input type="text" className="form-control form-control-sm" autoFocus
              value={newName} onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. Client Notes, Action Items, Feedback"
              style={{ borderRadius: 8 }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAdd(); } }} />
            <div className="d-flex justify-content-end gap-2 mt-2">
              <button className="btn btn-sm btn-outline-secondary"
                onClick={() => { setAdding(false); setNewName(''); }} disabled={busy === 'add'}>
                Cancel
              </button>
              <button className="btn btn-sm btn-dark"
                onClick={handleAdd} disabled={!newName.trim() || busy === 'add'}>
                {busy === 'add' ? <span className="spinner-border spinner-border-sm me-1" /> : <i className="bi bi-plus-lg me-1" />}
                Add
              </button>
            </div>
          </div>
        )}

        {sections.length === 0 && !adding ? (
          <div className="text-center text-muted py-3" style={{ fontSize: '0.78rem' }}>
            {readOnly
              ? 'The client hasn\'t added any sections for this brand yet.'
              : 'No client sections yet. Click + Add Section to create one.'}
          </div>
        ) : (
          <div className="d-flex flex-column gap-2">
            {sections.map((section) => {
              const isEditing = editingId === section.id;
              const value = valueFor(section.id);
              const hasValue = !!(value && value.trim && value.trim());
              const removing = busy === 'remove:' + section.id;
              const renaming = busy === 'rename:' + section.id;
              const saving = busy === 'save:' + section.id;
              return (
                <div key={section.id} className="rounded-3 p-3"
                  style={{ background: '#fafaff', border: '1px solid #e2e8f0' }}>
                  <div className="d-flex align-items-center justify-content-between mb-2 flex-wrap gap-2">
                    <div className="fw-semibold" style={{ fontSize: '0.85rem', color: '#1e293b' }}>
                      <i className="bi bi-bookmark-star me-1" style={{ color: '#8b5cf6' }} />
                      {section.name}
                    </div>
                    {!readOnly && !isEditing && (
                      <div className="d-flex gap-1">
                        <button className="btn btn-sm btn-light border-0"
                          style={{ padding: '2px 8px', fontSize: '0.7rem' }}
                          onClick={() => startEdit(section)}
                          title="Edit value for this report">
                          <i className="bi bi-pencil" /> {hasValue ? 'Edit' : 'Add value'}
                        </button>
                        <button className="btn btn-sm btn-light border-0"
                          style={{ padding: '2px 8px', fontSize: '0.7rem' }}
                          onClick={() => handleRename(section)}
                          disabled={renaming}
                          title="Rename section">
                          {renaming ? <span className="spinner-border spinner-border-sm" /> : <i className="bi bi-input-cursor-text" />}
                        </button>
                        <button className="btn btn-sm btn-light border-0 text-danger"
                          style={{ padding: '2px 8px', fontSize: '0.7rem' }}
                          onClick={() => handleRemove(section)}
                          disabled={removing}
                          title="Remove section from this brand">
                          {removing ? <span className="spinner-border spinner-border-sm" /> : <i className="bi bi-trash3" />}
                        </button>
                      </div>
                    )}
                  </div>

                  {isEditing ? (
                    <div>
                      <RichTextEditor
                        value={draft} onChange={setDraft}
                        minHeight={140}
                        placeholder="Type your notes here…"
                      />
                      <div className="d-flex justify-content-end gap-2 mt-2">
                        <button className="btn btn-sm btn-outline-secondary"
                          onClick={cancelEdit} disabled={saving}>Cancel</button>
                        <button className="btn btn-sm btn-dark"
                          onClick={() => handleSaveValue(section)} disabled={saving}>
                          {saving ? <><span className="spinner-border spinner-border-sm me-1" /> Saving…</> : <><i className="bi bi-check-lg me-1" /> Save</>}
                        </button>
                      </div>
                    </div>
                  ) : hasValue ? (
                    <div className="rich-content"
                      style={{ fontSize: '0.85rem', color: '#1e293b', lineHeight: 1.55 }}
                      dangerouslySetInnerHTML={{ __html: sanitizeRichHtml(value) }} />
                  ) : (
                    <div className="text-muted" style={{ fontSize: '0.76rem', fontStyle: 'italic' }}>
                      {readOnly ? 'No value yet for this report.' : 'Click "Add value" to fill in for this report.'}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
