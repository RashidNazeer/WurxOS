import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getBrandSections, addBrandSection, renameBrandSection, removeBrandSection,
} from '../../lib/brandReportSectionsApi';
import {
  PlusIcon, PencilIcon, TrashIcon, AlertIcon,
} from '../common/Icon';

/**
 * Brand Report Sections — management UI on the brand detail page.
 * Sections defined here auto-appear as long-form text fields in every
 * weekly / bi-weekly report for this brand. The author fills them
 * during report creation; values are stored per-report inside
 * data.customFields[sectionId].
 *
 * Different from BrandReportLinksPanel: that panel is for static
 * link sets shared across reports. This panel is for free-text
 * sections whose VALUE varies per report.
 */
export default function BrandReportSectionsPanel({ brandId, brandName }) {
  const qc = useQueryClient();
  const [error, setError]                 = useState('');
  const [adding, setAdding]               = useState(false);
  const [newName, setNewName]             = useState('');

  const { data: sections = [], isPending: loading } = useQuery({
    queryKey: ['brand-report-sections', brandId],
    queryFn: () => getBrandSections(brandId),
    enabled: !!brandId,
  });

  function reload() { qc.invalidateQueries({ queryKey: ['brand-report-sections', brandId] }); }

  async function handleAdd() {
    const name = newName.trim();
    if (!name) return;
    setError('');
    try {
      await addBrandSection(brandId, name);
      setNewName('');
      setAdding(false);
      reload();
    } catch (err) { setError(err.message || 'Could not add section.'); }
  }

  async function handleRename(section) {
    const next = window.prompt('Rename section:', section.name);
    if (next == null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === section.name) return;
    try { await renameBrandSection(brandId, section.id, trimmed); reload(); }
    catch (err) { setError(err.message || 'Rename failed.'); }
  }

  async function handleRemove(section) {
    const ok = window.confirm(
      `Remove section "${section.name}"?\n\nNew reports for this brand won't show this section anymore. Existing reports keep whatever value they already have.`
    );
    if (!ok) return;
    try { await removeBrandSection(brandId, section.id); reload(); }
    catch (err) { setError(err.message || 'Remove failed.'); }
  }

  return (
    <div className="wx-card" style={{ padding: 18 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <div style={{ minWidth: 0 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>
            Report Sections
          </h3>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, maxWidth: 560 }}>
            Add custom long-form sections (e.g. "Client Notes", "Roadmap Update") that auto-appear in every weekly and bi-weekly report for{' '}
            <strong style={{ color: 'var(--text-secondary)' }}>{brandName}</strong>. Authors fill the value during each report.
          </div>
        </div>
        {!adding && (
          <button className="wx-btn wx-btn-primary" onClick={() => { setAdding(true); setNewName(''); setError(''); }}>
            <PlusIcon width="13" height="13" /> New section
          </button>
        )}
      </div>

      {error && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 12 }}>
          <AlertIcon width="14" height="14" /> <span>{error}</span>
        </div>
      )}

      {adding && (
        <div style={{
          background: 'var(--accent-soft)',
          border: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)',
          borderRadius: 'var(--radius-md)',
          padding: 14,
          marginBottom: 14,
        }}>
          <label className="wx-label" style={{ marginBottom: 4 }}>Section name</label>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 8 }}>
            This becomes a heading in every new report for this brand. e.g. "Client Notes", "Roadmap Update", "Risks & Blockers".
          </div>
          <input className="wx-input" autoFocus
            placeholder="e.g. Client Notes"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAdd(); } }} />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
            <button className="wx-btn wx-btn-ghost"
              onClick={() => { setAdding(false); setNewName(''); }}>
              Cancel
            </button>
            <button className="wx-btn wx-btn-primary"
              onClick={handleAdd} disabled={!newName.trim()}>
              <PlusIcon width="13" height="13" /> Add section
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="wx-empty"><span className="wx-spinner" /> Loading…</div>
      ) : sections.length === 0 && !adding ? (
        <div className="wx-empty" style={{ border: '2px dashed var(--border-subtle)', borderRadius: 'var(--radius-lg)', padding: 32 }}>
          <div className="wx-empty-title">No custom sections yet</div>
          <div style={{ fontSize: 12.5 }}>Add your first section to make it appear in all of this brand's future reports.</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {sections.map((section) => (
            <div key={section.id} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '10px 14px',
              background: 'var(--surface-2)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-md)',
            }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', flex: 1, minWidth: 0 }}>
                {section.name}
              </div>
              {section.addedByName && (
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  added by {section.addedByName}
                </span>
              )}
              <button className="wx-btn wx-btn-ghost"
                onClick={() => handleRename(section)}
                style={{ padding: '4px 8px', fontSize: 11.5 }} title="Rename">
                <PencilIcon width="12" height="12" />
              </button>
              <button className="wx-btn wx-btn-ghost"
                onClick={() => handleRemove(section)}
                style={{ padding: '4px 8px', fontSize: 11.5, color: 'var(--danger)' }} title="Remove">
                <TrashIcon width="12" height="12" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
