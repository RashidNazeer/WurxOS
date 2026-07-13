// ============================================================
// SectionPresetBar — a compact "Save / Restore preset" control shown at the
// top of a report section. Save the section's current content (structured
// sections let you pick which fields), then Restore it into a later report of
// the same type. Presets are brand-scoped and shared (see migration 241).
//
// The `useSectionPresets` hook (bottom) binds this to a form's data/setData and
// returns ready-to-render elements: `bar(sectionKey, accent)` for hardcoded
// sections (looked up in reportPresetSections.js) and `custom(section, accent)`
// for brand custom sections (table → object, long_text → text).
// ============================================================
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  listSectionPresetsForType, saveSectionPreset, deleteSectionPreset,
} from '../../lib/reportSectionPresetsApi';
import { getPresetDescriptor } from './reportPresetSections';

const hasVal = (v) => v != null && String(v).trim() !== '' && String(v).trim() !== '<p></p>';

function currentHasContent(kind, current, fields) {
  if (kind === 'text') return hasVal(current);
  if (kind === 'rows') return Array.isArray(current) && current.some((r) => (fields || []).some((f) => hasVal(r?.[f.key])));
  if (kind === 'object') return (fields || []).some((f) => hasVal(current?.[f.key]));
  return false;
}

// Build the stored payload from the current content + chosen fields.
function buildPayload(kind, current, fields, selectedKeys) {
  if (kind === 'text') return { kind: 'text', html: String(current || '') };
  if (kind === 'rows') {
    const rows = (Array.isArray(current) ? current : [])
      .map((r) => { const o = {}; selectedKeys.forEach((k) => { o[k] = r?.[k] ?? ''; }); return o; })
      .filter((r) => Object.values(r).some(hasVal));
    return { kind: 'rows', fields: selectedKeys, rows };
  }
  const values = {};
  selectedKeys.forEach((k) => { values[k] = current?.[k] ?? ''; });
  return { kind: 'object', fields: selectedKeys, values };
}

const fmtDate = (s) => { try { return new Date(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch { return ''; } };

export default function SectionPresetBar({
  brandId, reportType, sectionKey, label, accent = 'var(--accent)', uid,
  kind, fields = [], current, onRestore,
  presets = [], onChanged,
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [selected, setSelected] = useState(() => new Set((fields || []).map((f) => f.key)));
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null); // { type:'ok'|'err', msg }
  const [confirmingId, setConfirmingId] = useState(null);

  const structured = kind === 'rows' || kind === 'object';
  const hasContent = currentHasContent(kind, current, fields);
  const selKeys = useMemo(() => fields.filter((f) => selected.has(f.key)).map((f) => f.key), [fields, selected]);
  const canSave = !!name.trim() && !busy && hasContent && (!structured || selKeys.length > 0);
  const softBg = `color-mix(in srgb, ${accent} 12%, transparent)`;

  const toggleField = (key) => setSelected((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const allSelected = structured && selected.size >= fields.length;
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(fields.map((f) => f.key)));

  async function handleSave() {
    if (!canSave) return;
    setBusy(true); setStatus(null);
    try {
      const payload = buildPayload(kind, current, fields, selKeys);
      await saveSectionPreset({ brandId, reportType, sectionKey, name: name.trim(), payload, uid });
      setName('');
      setStatus({ type: 'ok', msg: 'Preset saved.' });
      await onChanged?.();
    } catch (e) {
      setStatus({ type: 'err', msg: e?.message || 'Could not save the preset.' });
    } finally { setBusy(false); }
  }

  function doRestore(preset) {
    try { onRestore?.(preset.payload); } finally { setConfirmingId(null); setOpen(false); }
  }
  function handleRestoreClick(preset) {
    if (hasContent) setConfirmingId(preset.id);
    else doRestore(preset);
  }
  async function handleDelete(preset) {
    setBusy(true); setStatus(null);
    try { await deleteSectionPreset(preset.id); if (confirmingId === preset.id) setConfirmingId(null); await onChanged?.(); }
    catch (e) { setStatus({ type: 'err', msg: e?.message || 'Could not delete the preset.' }); }
    finally { setBusy(false); }
  }

  const count = presets.length;

  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="d-inline-flex align-items-center gap-1"
        style={{
          fontSize: '0.72rem', fontWeight: 700, padding: '3px 10px', borderRadius: 999,
          border: `1px solid ${open ? accent : 'var(--border-default)'}`,
          background: open ? softBg : 'var(--surface-1)',
          color: open ? accent : 'var(--text-secondary)', cursor: 'pointer',
        }}
        title="Save this section as a preset, or restore a saved one">
        <i className="bi bi-bookmarks" />
        Presets{count ? ` · ${count}` : ''}
        <i className={`bi bi-chevron-${open ? 'up' : 'down'}`} style={{ fontSize: '0.58rem' }} />
      </button>

      {open && (
        <div
          className="mt-2"
          style={{
            background: 'var(--surface-2)', border: '1px solid var(--border-subtle)',
            borderRadius: 10, padding: 12,
          }}>
          {/* ── Save current as a preset ── */}
          <div style={{ fontSize: '0.72rem', fontWeight: 800, color: 'var(--text-secondary)', letterSpacing: 0.2, marginBottom: 6 }}>
            SAVE THIS SECTION AS A PRESET
          </div>
          {!hasContent ? (
            <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginBottom: 4 }}>
              Fill in this section first, then you can save it as a reusable preset.
            </div>
          ) : (
            <>
              {structured && (
                <div className="d-flex flex-wrap align-items-center gap-1 mb-2">
                  <button
                    type="button" onClick={toggleAll}
                    style={{
                      fontSize: '0.66rem', fontWeight: 700, padding: '2px 8px', borderRadius: 999,
                      border: '1px dashed var(--border-default)', background: 'transparent',
                      color: 'var(--text-muted)', cursor: 'pointer',
                    }}
                    title={allSelected ? 'Unselect all fields' : 'Select all fields'}>
                    {allSelected ? 'None' : 'All'}
                  </button>
                  {fields.map((f) => {
                    const on = selected.has(f.key);
                    return (
                      <button
                        key={f.key} type="button" onClick={() => toggleField(f.key)}
                        style={{
                          fontSize: '0.68rem', fontWeight: 700, padding: '2px 8px', borderRadius: 999,
                          border: `1px solid ${on ? accent : 'var(--border-default)'}`,
                          background: on ? softBg : 'var(--surface-1)',
                          color: on ? accent : 'var(--text-muted)', cursor: 'pointer',
                        }}
                        title={on ? `“${f.label}” will be saved — click to exclude` : `Include “${f.label}”`}>
                        {on ? '✓ ' : ''}{f.label}
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="d-flex gap-2">
                <input
                  className="form-control form-control-sm"
                  style={{ borderRadius: 8, fontSize: '0.8rem' }}
                  placeholder="Preset name (e.g. Launch campaigns)"
                  value={name}
                  maxLength={80}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleSave(); } }} />
                <button
                  type="button"
                  className="btn btn-sm d-inline-flex align-items-center gap-1 flex-shrink-0"
                  style={{
                    borderRadius: 8, fontSize: '0.74rem', fontWeight: 700,
                    background: canSave ? accent : 'var(--surface-3)',
                    color: canSave ? '#fff' : 'var(--text-muted)',
                    border: 'none', opacity: canSave ? 1 : 0.7, cursor: canSave ? 'pointer' : 'not-allowed',
                  }}
                  disabled={!canSave}
                  onClick={handleSave}>
                  <i className="bi bi-save" /> {busy ? 'Saving…' : 'Save'}
                </button>
              </div>
              {structured && (
                <div style={{ fontSize: '0.66rem', color: 'var(--text-muted)', marginTop: 4 }}>
                  Only the ticked fields are saved; restoring fills those and leaves the rest blank.
                </div>
              )}
            </>
          )}

          {status && (
            <div style={{ fontSize: '0.72rem', marginTop: 6, color: status.type === 'ok' ? 'var(--success)' : 'var(--danger)' }}>
              {status.msg}
            </div>
          )}

          {/* ── Saved presets ── */}
          <div style={{ borderTop: '1px solid var(--border-subtle)', margin: '10px 0 8px' }} />
          <div style={{ fontSize: '0.72rem', fontWeight: 800, color: 'var(--text-secondary)', letterSpacing: 0.2, marginBottom: 6 }}>
            SAVED PRESETS{count ? ` (${count})` : ''}
          </div>
          {count === 0 ? (
            <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>No presets saved for this section yet.</div>
          ) : (
            <div className="d-flex flex-column gap-1" style={{ maxHeight: 220, overflowY: 'auto' }}>
              {presets.map((p) => (
                <div key={p.id}
                  style={{
                    background: 'var(--surface-1)', border: '1px solid var(--border-subtle)',
                    borderRadius: 8, padding: '6px 8px',
                  }}>
                  {confirmingId === p.id ? (
                    <div className="d-flex align-items-center gap-2 flex-wrap">
                      <span style={{ fontSize: '0.74rem', color: 'var(--text-secondary)' }}>
                        Replace the current content of this section with “{p.name}”?
                      </span>
                      <div className="d-flex gap-1 ms-auto">
                        <button type="button" className="btn btn-sm"
                          style={{ borderRadius: 6, fontSize: '0.7rem', fontWeight: 700, background: accent, color: '#fff', border: 'none' }}
                          onClick={() => doRestore(p)}>Replace</button>
                        <button type="button" className="btn btn-sm btn-light"
                          style={{ borderRadius: 6, fontSize: '0.7rem' }}
                          onClick={() => setConfirmingId(null)}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div className="d-flex align-items-center gap-2">
                      <div className="d-flex flex-column" style={{ minWidth: 0 }}>
                        <span style={{
                          fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-primary)',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>{p.name}</span>
                        <span style={{ fontSize: '0.64rem', color: 'var(--text-muted)' }}>
                          {p.payload?.kind === 'text' ? 'Text' : `${(p.payload?.rows?.length ?? 1)} · ${(p.payload?.fields?.length || 0)} field${(p.payload?.fields?.length || 0) === 1 ? '' : 's'}`} · saved {fmtDate(p.updated_at)}
                        </span>
                      </div>
                      <div className="d-flex gap-1 ms-auto flex-shrink-0">
                        <button type="button"
                          className="btn btn-sm d-inline-flex align-items-center gap-1"
                          style={{ borderRadius: 6, fontSize: '0.7rem', fontWeight: 700, border: `1px solid ${accent}`, color: accent, background: 'transparent' }}
                          onClick={() => handleRestoreClick(p)}
                          title="Fill this section from this preset">
                          <i className="bi bi-arrow-down-circle" /> Restore
                        </button>
                        <button type="button"
                          className="btn btn-sm btn-light border-0 text-danger"
                          style={{ padding: '2px 8px', fontSize: '0.7rem' }}
                          onClick={() => handleDelete(p)}
                          title="Delete this preset">
                          <i className="bi bi-trash3" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Hook: bind presets to a form's data/setData ─────────────────────────────
// Loads the brand+type's presets and returns element factories. Loaded presets
// are TAGGED with the brand+type they belong to and only served when that tag
// matches the currently-selected brand — so a slow/out-of-order fetch after a
// brand switch can NEVER surface one brand's presets in another brand's form
// (the brand-isolation invariant; the report forms switch brand in place, so
// this hook stays mounted across the switch).
const EMPTY_PRESETS = {};
export function useSectionPresets({ brandId, reportType, data, setData, uid }) {
  const [loaded, setLoaded] = useState({ brand: null, type: null, bySection: {} });

  // Fetch on brand/type change: clear immediately, and ignore a stale
  // (cancelled) response so the last-resolved promise can't win for the wrong
  // brand — the same cancellation guard useBrandSections uses.
  useEffect(() => {
    setLoaded({ brand: null, type: null, bySection: {} });
    if (!brandId || !reportType) return undefined;
    let cancelled = false;
    listSectionPresetsForType(brandId, reportType).then((grouped) => {
      if (!cancelled) setLoaded({ brand: brandId, type: reportType, bySection: grouped || {} });
    });
    return () => { cancelled = true; };
  }, [brandId, reportType]);

  // Re-fetch after a save/delete on the current brand (passed as onChanged).
  const refetch = useCallback(async () => {
    if (!brandId || !reportType) { setLoaded({ brand: null, type: null, bySection: {} }); return; }
    const grouped = await listSectionPresetsForType(brandId, reportType);
    setLoaded({ brand: brandId, type: reportType, bySection: grouped || {} });
  }, [brandId, reportType]);

  // Serve presets ONLY when the loaded set belongs to the current brand+type —
  // otherwise an empty list, never another brand's presets.
  const bySection = (loaded.brand === brandId && loaded.type === reportType) ? loaded.bySection : EMPTY_PRESETS;

  // Hardcoded section (descriptor-driven).
  const bar = useCallback((sectionKey, accent) => {
    const desc = getPresetDescriptor(reportType, sectionKey);
    if (!desc || !brandId) return null;
    const { label, kind, dataKey, fields } = desc;
    const current = kind === 'rows'
      ? (Array.isArray(data[dataKey]) ? data[dataKey] : [])
      : (data[dataKey] ?? '');
    const onRestore = (payload) => {
      if (kind === 'rows') {
        const blank = Object.fromEntries((fields || []).map((f) => [f.key, '']));
        const restored = (payload?.rows || []).map((r) => ({ ...blank, ...r }));
        setData((d) => ({ ...d, [dataKey]: restored }));
      } else {
        setData((d) => ({ ...d, [dataKey]: payload?.html || '' }));
      }
    };
    return (
      <SectionPresetBar
        key={`preset-${sectionKey}`}
        brandId={brandId} reportType={reportType} sectionKey={sectionKey}
        label={label} accent={accent} uid={uid}
        kind={kind} fields={fields} current={current} onRestore={onRestore}
        presets={bySection[sectionKey] || []} onChanged={refetch} />
    );
  }, [reportType, brandId, data, setData, uid, bySection, refetch]);

  // Brand custom section: table → object (per-field values), long_text → text.
  const custom = useCallback((section, accent) => {
    if (!section?.id || !brandId) return null;
    if (section.kind === 'table') {
      const fields = (section.fields || []).map((f) => ({ key: f.id, label: f.label }));
      const current = Object.fromEntries((section.fields || []).map((f) => [f.id, data.customFields?.[f.id]?.value ?? '']));
      const onRestore = (payload) => setData((d) => {
        const cf = { ...(d.customFields || {}) };
        (payload?.fields || []).forEach((fid) => {
          const def = (section.fields || []).find((f) => f.id === fid);
          if (!def) return;
          cf[fid] = { name: def.label, value: payload.values?.[fid] ?? '', kind: 'table', sectionId: section.id, sectionName: section.name, type: def.type, source: 'brand' };
        });
        return { ...d, customFields: cf };
      });
      return (
        <SectionPresetBar key={`preset-${section.id}`}
          brandId={brandId} reportType={reportType} sectionKey={section.id}
          label={section.name} accent={accent} uid={uid}
          kind="object" fields={fields} current={current} onRestore={onRestore}
          presets={bySection[section.id] || []} onChanged={refetch} />
      );
    }
    const entry = data.customFields?.[section.id];
    const current = typeof entry === 'string' ? entry : (entry?.value || '');
    const onRestore = (payload) => setData((d) => ({
      ...d,
      customFields: { ...(d.customFields || {}), [section.id]: { name: section.name, value: payload?.html || '', kind: 'long_text', source: 'brand' } },
    }));
    return (
      <SectionPresetBar key={`preset-${section.id}`}
        brandId={brandId} reportType={reportType} sectionKey={section.id}
        label={section.name} accent={accent} uid={uid}
        kind="text" fields={[]} current={current} onRestore={onRestore}
        presets={bySection[section.id] || []} onChanged={refetch} />
    );
  }, [reportType, brandId, data, setData, uid, bySection, refetch]);

  return { bar, custom, refetch };
}
