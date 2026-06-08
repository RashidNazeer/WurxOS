import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getBrandReportResources,
  addReportSection, renameReportSection, removeReportSection,
  setReportSectionApplies,
  addReportLink, updateReportLink, removeReportLink,
  REPORT_TYPES,
} from '../../lib/brandReportResourcesApi';

const REPORT_TYPE_LABEL = { weekly: 'Weekly', biweekly: 'Bi-Weekly', monthly: 'Monthly' };
// Legacy sections (no appliesTo field set) historically rendered in
// all three. Show that as the displayed selection until the user
// explicitly changes it.
function effectiveApplies(section) {
  if (Array.isArray(section?.appliesTo) && section.appliesTo.length) return section.appliesTo;
  return REPORT_TYPES.slice();
}
import {
  PlusIcon, XIcon, PencilIcon, TrashIcon, LinkIcon,
  BookmarkIcon, AlertIcon,
} from '../common/Icon';

/**
 * Brand Report Links — management UI on the brand detail page.
 * Sections + links saved here auto-render in every weekly /
 * bi-weekly / monthly report for this brand. See ReportView for
 * the in-report renderer (BrandReportLinks).
 */
export default function BrandReportLinksPanel({ brandId, brandName }) {
  const qc = useQueryClient();
  const [error, setError]                 = useState('');
  const [addingSection, setAddingSection] = useState(false);
  const [newSectionName, setNewSectionName] = useState('');
  // Default: new sections render in weekly reports only. User can
  // tick bi-weekly / monthly here before saving.
  const [newSectionApplies, setNewSectionApplies] = useState(['weekly']);

  const { data: sections = [], isPending: loading } = useQuery({
    queryKey: ['brand-report-resources', brandId],
    queryFn: () => getBrandReportResources(brandId),
    enabled: !!brandId,
  });

  function reload() { qc.invalidateQueries({ queryKey: ['brand-report-resources', brandId] }); }

  async function handleAddSection() {
    const name = newSectionName.trim();
    if (!name) return;
    if (!newSectionApplies.length) {
      return setError('Pick at least one report type for this section.');
    }
    setError('');
    try {
      await addReportSection(brandId, name, newSectionApplies);
      setNewSectionName('');
      setNewSectionApplies(['weekly']);
      setAddingSection(false);
      reload();
    } catch (err) { setError(err.message || 'Could not add section.'); }
  }

  async function handleToggleApplies(section, reportType) {
    const current = effectiveApplies(section);
    const next = current.includes(reportType)
      ? current.filter((t) => t !== reportType)
      : [...current, reportType];
    if (!next.length) {
      return setError(`"${section.name}" needs to apply to at least one report type. Untick another first.`);
    }
    setError('');
    try {
      await setReportSectionApplies(brandId, section.id, next);
      reload();
    } catch (err) { setError(err.message || 'Could not update.'); }
  }

  async function handleRenameSection(section) {
    const next = window.prompt('Rename section:', section.name);
    if (next == null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === section.name) return;
    try { await renameReportSection(brandId, section.id, trimmed); reload(); }
    catch (err) { setError(err.message || 'Rename failed.'); }
  }

  async function handleRemoveSection(section) {
    const ok = window.confirm(
      `Remove section "${section.name}"?\n\nThis will also remove its ${(section.links || []).length} link(s) from every report for this brand.`
    );
    if (!ok) return;
    try { await removeReportSection(brandId, section.id); reload(); }
    catch (err) { setError(err.message || 'Remove failed.'); }
  }

  return (
    <div className="wx-card" style={{ padding: 18 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <div style={{ minWidth: 0 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>
            Report Links
          </h3>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, maxWidth: 620 }}>
            Links saved here auto-render in reports for{' '}
            <strong style={{ color: 'var(--text-secondary)' }}>{brandName}</strong>. Pick which report
            types each section appears in — new sections default to <strong>weekly only</strong>.
          </div>
        </div>
        {!addingSection && (
          <button className="wx-btn wx-btn-primary" onClick={() => { setAddingSection(true); setNewSectionName(''); setError(''); }}>
            <PlusIcon width="13" height="13" /> New section
          </button>
        )}
      </div>

      {error && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 12 }}>
          <AlertIcon width="14" height="14" /> <span>{error}</span>
        </div>
      )}

      {addingSection && (
        <div style={{
          background: 'var(--accent-soft)',
          border: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)',
          borderRadius: 'var(--radius-md)',
          padding: 14,
          marginBottom: 14,
        }}>
          <label className="wx-label" style={{ marginBottom: 4 }}>Section name</label>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 8 }}>
            This is the heading that will appear above the links in every report. e.g. "Weekly TikTok Retainer Updates", "Brand Documents".
          </div>
          <input className="wx-input" autoFocus
            placeholder="e.g. Weekly TikTok Retainer Updates"
            value={newSectionName}
            onChange={(e) => setNewSectionName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddSection(); } }} />
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginBottom: 6, fontWeight: 600 }}>
              Appears in:
            </div>
            <AppliesChips
              applies={newSectionApplies}
              onToggle={(t) => {
                setNewSectionApplies((cur) => cur.includes(t)
                  ? cur.filter((x) => x !== t)
                  : [...cur, t]);
              }}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
            <button className="wx-btn wx-btn-ghost"
              onClick={() => { setAddingSection(false); setNewSectionName(''); }}>
              Cancel
            </button>
            <button className="wx-btn wx-btn-primary"
              onClick={handleAddSection} disabled={!newSectionName.trim()}>
              <PlusIcon width="13" height="13" /> Add section
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="wx-empty"><span className="wx-spinner" /> Loading…</div>
      ) : sections.length === 0 && !addingSection ? (
        <div className="wx-empty" style={{ border: '2px dashed var(--border-subtle)', borderRadius: 'var(--radius-lg)', padding: 32 }}>
          <LinkIcon width="28" height="28" style={{ opacity: 0.35 }} />
          <div className="wx-empty-title" style={{ marginTop: 8 }}>No report-link sections yet</div>
          <div style={{ fontSize: 12.5 }}>Add your first section to embed links into this brand's reports automatically.</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {sections.map((section) => (
            <SectionCard
              key={section.id}
              section={section}
              brandId={brandId}
              onRename={() => handleRenameSection(section)}
              onRemove={() => handleRemoveSection(section)}
              onToggleApplies={(t) => handleToggleApplies(section, t)}
              onChanged={reload}
              setError={setError}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================
// SectionCard — header + list of links + add-link form
// ============================================================
function SectionCard({ section, brandId, onRename, onRemove, onToggleApplies, onChanged, setError }) {
  const [adding, setAdding] = useState(false);
  const [editingLinkId, setEditingLinkId] = useState(null);

  async function handleAddLink(label, url) {
    try { await addReportLink(brandId, section.id, label, url); onChanged(); }
    catch (err) { setError(err.message || 'Add link failed.'); throw err; }
  }
  async function handleEditLink(linkId, label, url) {
    try { await updateReportLink(brandId, section.id, linkId, label, url); onChanged(); }
    catch (err) { setError(err.message || 'Edit link failed.'); throw err; }
  }
  async function handleRemoveLink(linkId, label) {
    const ok = window.confirm(`Remove link "${label}"?`);
    if (!ok) return;
    try { await removeReportLink(brandId, section.id, linkId); onChanged(); }
    catch (err) { setError(err.message || 'Remove link failed.'); }
  }

  const links = section.links || [];

  return (
    <div style={{
      background: 'var(--surface-2)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 'var(--radius-md)',
      overflow: 'hidden',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
        padding: '10px 14px',
        background: 'var(--surface-1)',
        borderBottom: '1px solid var(--border-subtle)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <BookmarkIcon width="14" height="14" style={{ color: 'var(--accent)', flexShrink: 0 }} />
          <span style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {section.name}
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            · {links.length} link{links.length !== 1 ? 's' : ''}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
          <button className="wx-btn wx-btn-ghost" onClick={onRename}
            style={{ padding: '4px 8px', fontSize: 11.5 }} title="Rename section">
            <PencilIcon width="12" height="12" />
          </button>
          <button className="wx-btn wx-btn-ghost" onClick={onRemove}
            style={{ padding: '4px 8px', fontSize: 11.5, color: 'var(--danger)' }} title="Remove section">
            <TrashIcon width="12" height="12" />
          </button>
        </div>
      </div>

      <div style={{ padding: 12 }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap',
        }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', letterSpacing: '0.02em' }}>
            APPEARS IN
          </span>
          <AppliesChips
            applies={effectiveApplies(section)}
            onToggle={onToggleApplies}
          />
        </div>

        {links.length === 0 && !adding && (
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 8 }}>
            No links in this section yet.
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {links.map((link) => (
            editingLinkId === link.id ? (
              <LinkEditor key={link.id}
                initialLabel={link.label} initialUrl={link.url}
                onSave={async (label, url) => { await handleEditLink(link.id, label, url); setEditingLinkId(null); }}
                onCancel={() => setEditingLinkId(null)} />
            ) : (
              <div key={link.id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '8px 10px',
                  background: 'var(--surface-1)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-sm)',
                }}>
                <LinkIcon width="13" height="13" style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 12.5, color: 'var(--text-primary)' }}>{link.label}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {link.url}
                  </div>
                </div>
                <button className="wx-btn wx-btn-ghost"
                  onClick={() => setEditingLinkId(link.id)}
                  style={{ padding: '4px 8px', fontSize: 11.5 }} title="Edit">
                  <PencilIcon width="12" height="12" />
                </button>
                <button className="wx-btn wx-btn-ghost"
                  onClick={() => handleRemoveLink(link.id, link.label)}
                  style={{ padding: '4px 8px', fontSize: 11.5, color: 'var(--danger)' }} title="Remove">
                  <TrashIcon width="12" height="12" />
                </button>
              </div>
            )
          ))}
        </div>

        {adding ? (
          <div style={{ marginTop: links.length ? 8 : 0 }}>
            <LinkEditor
              onSave={async (label, url) => { await handleAddLink(label, url); setAdding(false); }}
              onCancel={() => setAdding(false)} />
          </div>
        ) : (
          <button className="wx-btn wx-btn-ghost" onClick={() => setAdding(true)}
            style={{ marginTop: links.length ? 8 : 0, padding: '6px 12px', fontSize: 12 }}>
            <PlusIcon width="12" height="12" /> Add link
          </button>
        )}
      </div>
    </div>
  );
}

// ============================================================
// LinkEditor — small inline form for add/edit
// ============================================================
function LinkEditor({ initialLabel = '', initialUrl = '', onSave, onCancel }) {
  const [label, setLabel] = useState(initialLabel);
  const [url, setUrl]     = useState(initialUrl);
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!label.trim() || !url.trim() || saving) return;
    setSaving(true);
    try { await onSave(label.trim(), url.trim()); }
    catch { /* parent owns the error toast */ }
    finally { setSaving(false); }
  }

  return (
    <div style={{
      padding: 12,
      background: 'var(--surface-1)',
      border: '1px dashed var(--border-default)',
      borderRadius: 'var(--radius-sm)',
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <input className="wx-input" autoFocus
        placeholder="Label (e.g. Weekly Updates)"
        value={label} onChange={(e) => setLabel(e.target.value)} />
      <input className="wx-input"
        placeholder="https://…"
        value={url} onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button className="wx-btn wx-btn-ghost" onClick={onCancel} disabled={saving}>Cancel</button>
        <button className="wx-btn wx-btn-primary" onClick={submit}
          disabled={saving || !label.trim() || !url.trim()}>
          {saving ? <><span className="wx-spinner" /> Saving…</> : <><CheckLikePlus /> Save</>}
        </button>
      </div>
    </div>
  );
}

function CheckLikePlus() {
  // Tiny check glyph — avoids a wider import for one icon.
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

// ============================================================
// AppliesChips — three toggle chips (Weekly · Bi-Weekly · Monthly)
// Active = filled accent. Inactive = ghost. Click toggles inclusion.
// ============================================================
function AppliesChips({ applies = [], onToggle }) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {REPORT_TYPES.map((t) => {
        const on = applies.includes(t);
        return (
          <button
            key={t}
            type="button"
            onClick={() => onToggle?.(t)}
            style={{
              fontSize: 11, fontWeight: 700,
              padding: '4px 10px',
              borderRadius: 'var(--radius-pill)',
              border: on ? '1px solid var(--accent)' : '1px solid var(--border-default)',
              background: on ? 'var(--accent-soft)' : 'var(--surface-1)',
              color: on ? 'var(--accent)' : 'var(--text-muted)',
              cursor: 'pointer',
              transition: 'all 120ms ease',
            }}
            title={on ? `Showing in ${REPORT_TYPE_LABEL[t]} reports — click to hide` : `Click to show in ${REPORT_TYPE_LABEL[t]} reports`}
          >
            {on ? '✓ ' : ''}{REPORT_TYPE_LABEL[t]}
          </button>
        );
      })}
    </div>
  );
}
