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
  getBrandSections, normalizeSection,
  getBrandSectionExtras, addBrandSectionExtraField, removeBrandSectionExtraField,
  addBrandSectionRich, removeBrandSection,
} from '../../lib/brandReportSectionsApi';

export function useBrandSections({ brandId, setData }) {
  const [brandSectionDefs, setBrandSectionDefs] = useState([]);
  const [brandSectionExtras, setBrandSectionExtras] = useState({});

  // Load brand-level custom sections + per-built-in-section extras whenever
  // the selected brand changes. Client-portal sections (addedBy:'client')
  // are excluded — they belong in the read-only Client Sections panel.
  useEffect(() => {
    if (!brandId) { setBrandSectionDefs([]); setBrandSectionExtras({}); return undefined; }
    let cancelled = false;
    Promise.all([
      getBrandSections(brandId).catch(() => []),
      getBrandSectionExtras(brandId).catch(() => ({})),
    ]).then(([list, extras]) => {
      if (cancelled) return;
      setBrandSectionDefs(list.filter((s) => s?.addedBy !== 'client').map(normalizeSection));
      setBrandSectionExtras(extras || {});
    });
    return () => { cancelled = true; };
  }, [brandId]);

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
    const saved = await addBrandSectionRich(brandId, payload);
    setBrandSectionDefs((prev) => [...prev, normalizeSection(saved)]);
  }, [brandId]);

  // Permanently delete an APC-created custom section. Removes the brand-level
  // definition (stops appearing on future reports) and strips this report's
  // entries + visibility flag so nothing orphaned is saved. Reports already
  // saved keep their data.
  const deleteBrandCustomSection = useCallback(async (section) => {
    if (!brandId || !section?.id) return;
    const ok = window.confirm(
      `Delete the custom section "${section.name}"?\n\n`
      + "It will be removed from this brand and won't appear on future "
      + 'reports. Reports already saved keep whatever they had.',
    );
    if (!ok) return;
    try {
      await removeBrandSection(brandId, section.id);
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

// Save-time filter: keep only custom-field entries that are still valid —
// brand-scoped entries (source:'brand' or a known kind) always survive; legacy
// per-user entries survive only if their def still exists (`userFieldIds`).
// This is what prevents brand-section entries from being wiped on save.
export function cleanCustomFields(customFields, userFieldIds) {
  const ids = userFieldIds instanceof Set ? userFieldIds : new Set(userFieldIds || []);
  return Object.fromEntries(
    Object.entries(customFields || {}).filter(([id, entry]) => {
      if (ids.has(id)) return true;
      if (entry && typeof entry === 'object') {
        if (entry.source === 'brand') return true;
        if (entry.kind === 'long_text' || entry.kind === 'table' || entry.kind === 'builtin_extra') return true;
      }
      return false;
    })
  );
}
