// ============================================================
// useBrandSections — shared load + CRUD for brand-scoped custom report
// sections, used by the Weekly / Bi-Weekly / Monthly report forms.
//
// Loads a brand's custom sections (`brandSectionDefs`) and its per-built-in-
// section extra fields (`brandSectionExtras`) whenever the selected brand
// changes, and returns handlers that persist to the brand template AND keep
// the current report draft's `data.customFields` free of orphaned entries.
//
// Extracted from WeeklyReportForm so every report type behaves identically.
// ============================================================
import { useEffect, useState, useCallback } from 'react';
import {
  getBrandSections, normalizeSection, sectionAppliesTo,
  getBrandSectionExtras, addBrandSectionExtraField, removeBrandSectionExtraField,
  addBrandSectionRich, removeBrandSection,
} from '../../lib/brandReportSectionsApi';
import {
  countSectionPresetsForSection, deleteSectionPresetsForSection,
} from '../../lib/reportSectionPresetsApi';

// `reportType` ('weekly' | 'biweekly' | 'monthly') scopes which sections this
// form sees: only sections whose appliesTo includes this type (a section with
// no appliesTo is legacy → applies to all types). New sections created from
// this form default to appearing in THIS report type only. Omit reportType to
// see/create for all types (back-compat).
export function useBrandSections({ brandId, setData, reportType }) {
  const [brandSectionDefs, setBrandSectionDefs] = useState([]);
  const [brandSectionExtras, setBrandSectionExtras] = useState({});

  // Load brand-level custom sections + per-built-in-section extras whenever
  // the selected brand changes. Client-portal sections (addedBy:'client')
  // are excluded — they belong in the read-only Client Sections panel.
  // Sections are also filtered to those that apply to THIS report type.
  useEffect(() => {
    if (!brandId) { setBrandSectionDefs([]); setBrandSectionExtras({}); return undefined; }
    let cancelled = false;
    Promise.all([
      getBrandSections(brandId).catch(() => []),
      getBrandSectionExtras(brandId).catch(() => ({})),
    ]).then(([list, extras]) => {
      if (cancelled) return;
      const scoped = list
        .filter((s) => s?.addedBy !== 'client')
        .map(normalizeSection)
        .filter((s) => !reportType || sectionAppliesTo(s, reportType));
      setBrandSectionDefs(scoped);
      setBrandSectionExtras(extras || {});
    });
    return () => { cancelled = true; };
  }, [brandId, reportType]);

  const addExtraField = useCallback(async (sectionKey, field) => {
    if (!brandId) return;
    const saved = await addBrandSectionExtraField(brandId, sectionKey, field);
    setBrandSectionExtras((prev) => {
      const list = Array.isArray(prev[sectionKey]) ? prev[sectionKey] : [];
      return { ...prev, [sectionKey]: [...list, saved] };
    });
  }, [brandId]);

  const removeExtraField = useCallback(async (sectionKey, fieldId) => {
    if (!brandId) return;
    await removeBrandSectionExtraField(brandId, sectionKey, fieldId);
    setBrandSectionExtras((prev) => {
      const list = Array.isArray(prev[sectionKey]) ? prev[sectionKey] : [];
      return { ...prev, [sectionKey]: list.filter((f) => f.id !== fieldId) };
    });
    // Drop any value entries for this field id from the report draft.
    setData((d) => {
      if (!d.customFields || !d.customFields[fieldId]) return d;
      const next = { ...d.customFields };
      delete next[fieldId];
      return { ...d, customFields: next };
    });
  }, [brandId, setData]);

  const addBrandCustomSection = useCallback(async (payload) => {
    if (!brandId) return;
    // Default a new section's report-type scope to THIS form's type unless the
    // Add UI explicitly chose types (payload.appliesTo). So a section added on
    // a monthly report is monthly-only by default and won't appear on weekly —
    // matching "show in which they were created".
    const finalPayload = (payload?.appliesTo || !reportType)
      ? payload
      : { ...payload, appliesTo: [reportType] };
    const saved = await addBrandSectionRich(brandId, finalPayload);
    const norm = normalizeSection(saved);
    // Surface it in this form only if it applies here (respects a multi-type
    // choice that might exclude this type).
    setBrandSectionDefs((prev) =>
      (!reportType || sectionAppliesTo(norm, reportType)) ? [...prev, norm] : prev);
  }, [brandId, reportType]);

  // Permanently delete an APC-created custom section. Removes the brand-level
  // definition (stops appearing on future reports) and strips this report's
  // entries + visibility flag so nothing orphaned is saved. Reports already
  // saved keep their data.
  const deleteBrandCustomSection = useCallback(async (section) => {
    if (!brandId || !section?.id) return;
    // Presets are tied to the section's id and can't be a DB cascade (sections
    // aren't rows), so we delete them here — and warn how many will be lost.
    // Recreating a same-named section gets a fresh id, so they never come back.
    let presetCount = 0;
    try { presetCount = await countSectionPresetsForSection(brandId, section.id); } catch { /* non-fatal */ }
    const presetWarning = presetCount > 0
      ? `\n\nThis will ALSO permanently delete ${presetCount} saved preset${presetCount === 1 ? '' : 's'} for this section. `
        + 'Recreating a section with the same name will NOT bring them back.'
      : '';
    const ok = window.confirm(
      `Delete the custom section "${section.name}"?\n\n`
      + "It will be removed from this brand and won't appear on future "
      + 'reports. Reports already saved keep whatever they had.'
      + presetWarning,
    );
    if (!ok) return;
    try {
      await removeBrandSection(brandId, section.id);
      if (presetCount > 0) await deleteSectionPresetsForSection(brandId, section.id);
    } catch (err) {
      alert('Failed to delete the section: ' + (err?.message || 'unknown error'));
      return;
    }
    setBrandSectionDefs((prev) => prev.filter((s) => s.id !== section.id));
    setData((d) => {
      const nextFields = { ...(d.customFields || {}) };
      let changed = false;
      for (const [k, v] of Object.entries(nextFields)) {
        if (k === section.id || (v && typeof v === 'object' && v.sectionId === section.id)) {
          delete nextFields[k];
          changed = true;
        }
      }
      const nextEnabled = { ...(d.sectionsEnabled || {}) };
      if (section.id in nextEnabled) { delete nextEnabled[section.id]; changed = true; }
      return changed ? { ...d, customFields: nextFields, sectionsEnabled: nextEnabled } : d;
    });
  }, [brandId, setData]);

  return {
    brandSectionDefs, brandSectionExtras,
    addExtraField, removeExtraField, addBrandCustomSection, deleteBrandCustomSection,
  };
}

// Save-time filter: keep custom-field entries that are still valid —
// brand-scoped entries (source:'brand' or a known kind) always survive; legacy
// per-user entries survive if their def still exists (`userFieldIds`).
// This is what prevents brand-section entries from being wiped on save.
//
// CRITICAL (2026-07-03): we ALSO keep any entry that carries content, even if
// it has no source/kind marker and its per-user def is gone. Reason: an APC
// once created a per-USER custom field ("paid monthly report" link), which
// leaked onto every brand's monthly report; when that per-user def was later
// deleted, this filter silently stripped the FILLED-IN entry from every
// brand's saved report on their next save — data loss the user never
// authorized. Never delete a section a human typed into just because its
// template definition disappeared. An entry is only dropped if it is empty
// (no value) AND has no marker AND its def is gone — a true orphan.
function _hasContent(entry) {
  if (entry == null) return false;
  if (typeof entry === 'string') return entry.trim() !== '' && entry.trim() !== '<p></p>';
  if (typeof entry === 'object') {
    const v = entry.value;
    if (typeof v === 'string') return v.trim() !== '' && v.trim() !== '<p></p>';
    if (v != null && typeof v === 'object') return Object.keys(v).length > 0; // table rows
    return v != null;
  }
  return false;
}
export function cleanCustomFields(customFields, userFieldIds) {
  const ids = userFieldIds instanceof Set ? userFieldIds : new Set(userFieldIds || []);
  return Object.fromEntries(
    Object.entries(customFields || {}).filter(([id, entry]) => {
      if (ids.has(id)) return true;
      if (entry && typeof entry === 'object') {
        if (entry.source === 'brand') return true;
        if (entry.kind === 'long_text' || entry.kind === 'table' || entry.kind === 'builtin_extra') return true;
      }
      // Last resort: keep anything a human actually filled in, even without a
      // marker — better a harmless orphan than silent deletion of real text.
      if (_hasContent(entry)) return true;
      return false;
    })
  );
}
