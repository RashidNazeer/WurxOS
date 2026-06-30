// ============================================================
// Brand Report Sections — per-brand custom long-form text sections
// that auto-appear in every weekly / bi-weekly report for the
// brand. Distinct from brand_report_resources (links): these are
// text fields whose VALUE is per-report (filled in the form), but
// whose NAME / template is per-brand.
//
// Storage: brand_report_sections(brand_id, sections jsonb).
// See migration 104.
// ============================================================

import { supabase } from './supabase';

function genId() {
  return `cs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export async function getBrandSections(brandId) {
  if (!brandId) return [];
  const { data, error } = await supabase
    .from('brand_report_sections')
    .select('sections')
    .eq('brand_id', brandId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data?.sections || [];
}

async function writeSections(brandId, sections) {
  const { error } = await supabase
    .from('brand_report_sections')
    .upsert({ brand_id: brandId, sections }, { onConflict: 'brand_id' });
  if (error) throw new Error(error.message);
}

// --------------- Built-in section "extras" ---------------------------
// Custom fields *inside* a built-in section (e.g. "Total User Count"
// inside Overall Performance) live in the `extras` jsonb on the same
// row. Keyed by the form's internal section key.

export async function getBrandSectionExtras(brandId) {
  if (!brandId) return {};
  const { data, error } = await supabase
    .from('brand_report_sections')
    .select('extras')
    .eq('brand_id', brandId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data?.extras || {};
}

async function writeExtras(brandId, extras) {
  const { error } = await supabase
    .from('brand_report_sections')
    .upsert({ brand_id: brandId, extras }, { onConflict: 'brand_id' });
  if (error) throw new Error(error.message);
}

// --------------- Built-in section VISIBILITY (per brand) -------------
// Whether a built-in section (e.g. "GMV Breakdown") shows in this
// brand's reports. Keyed by the form's camelCase section key, value
// boolean. Missing key → caller's code default. Lives in the
// `section_visibility` jsonb on the same row (migration 216).

export async function getBrandSectionVisibility(brandId) {
  if (!brandId) return {};
  const { data, error } = await supabase
    .from('brand_report_sections')
    .select('section_visibility')
    .eq('brand_id', brandId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data?.section_visibility || {};
}

export async function setBrandSectionVisibility(brandId, sectionKey, enabled) {
  if (!brandId || !sectionKey) throw new Error('Brand and section are required.');
  const vis = await getBrandSectionVisibility(brandId);
  const next = { ...vis, [sectionKey]: !!enabled };
  // Upsert only this column — Postgres merges, leaving sections/extras intact.
  const { error } = await supabase
    .from('brand_report_sections')
    .upsert({ brand_id: brandId, section_visibility: next }, { onConflict: 'brand_id' });
  if (error) throw new Error(error.message);
  return next;
}

function normalizeExtraField(f) {
  return {
    id: f.id || genId(),
    label: String(f.label || '').trim(),
    type: FIELD_TYPES.includes(f.type) ? f.type : 'text',
    options: Array.isArray(f.options)
      ? f.options.map((o) => String(o).trim()).filter(Boolean)
      : [],
  };
}

export async function addBrandSectionExtraField(brandId, sectionKey, field) {
  if (!brandId || !sectionKey) throw new Error('Brand and section are required.');
  const cleaned = normalizeExtraField(field);
  if (!cleaned.label) throw new Error('Field label is required.');
  const extras = await getBrandSectionExtras(brandId);
  const list = Array.isArray(extras[sectionKey]) ? extras[sectionKey] : [];
  if (list.some((f) => f.label.toLowerCase() === cleaned.label.toLowerCase())) {
    throw new Error('A field with this label already exists in this section.');
  }
  const next = { ...extras, [sectionKey]: [...list, cleaned] };
  await writeExtras(brandId, next);
  return cleaned;
}

export async function removeBrandSectionExtraField(brandId, sectionKey, fieldId) {
  const extras = await getBrandSectionExtras(brandId);
  const list = Array.isArray(extras[sectionKey]) ? extras[sectionKey] : [];
  const next = { ...extras, [sectionKey]: list.filter((f) => f.id !== fieldId) };
  await writeExtras(brandId, next);
}

// Field types allowed inside table-kind sections.
export const FIELD_TYPES = ['text', 'number', 'currency', 'url', 'dropdown'];

// Normalize a section so older rows (which have no `kind`) read as
// long-text. Field defs without an id get one. Dropdown options are
// coerced to an array.
export function normalizeSection(s) {
  const kind = s.kind === 'table' ? 'table' : 'long_text';
  const fields = Array.isArray(s.fields) ? s.fields.map((f) => ({
    id: f.id || genId(),
    label: String(f.label || '').trim(),
    type: FIELD_TYPES.includes(f.type) ? f.type : 'text',
    options: Array.isArray(f.options) ? f.options.map(String) : [],
  })) : [];
  return { ...s, kind, fields };
}

export async function addBrandSection(brandId, name, addedByName = '') {
  return addBrandSectionRich(brandId, { name, kind: 'long_text' }, addedByName);
}

/**
 * Add a section with full structure. `payload`:
 *   { name, kind: 'table' | 'long_text', fields?: [{ label, type, options? }] }
 * Returns the persisted section.
 */
export async function addBrandSectionRich(brandId, payload, addedByName = '') {
  const name = (payload?.name || '').trim();
  if (!brandId || !name) throw new Error('Brand and section name are required.');
  const kind = payload?.kind === 'table' ? 'table' : 'long_text';
  const fields = kind === 'table' && Array.isArray(payload.fields)
    ? payload.fields.map((f) => ({
        id: genId(),
        label: String(f.label || '').trim(),
        type: FIELD_TYPES.includes(f.type) ? f.type : 'text',
        options: Array.isArray(f.options)
          ? f.options.map((o) => String(o).trim()).filter(Boolean)
          : [],
      })).filter((f) => f.label)
    : [];
  if (kind === 'table' && fields.length === 0) {
    throw new Error('A table section needs at least one field.');
  }
  const sections = (await getBrandSections(brandId)).map(normalizeSection);
  if (sections.some((s) => (s.name || '').toLowerCase() === name.toLowerCase())) {
    throw new Error('A section with this name already exists for this brand.');
  }
  const section = {
    id: genId(),
    name,
    kind,
    fields,
    addedByName: addedByName || '',
    addedAt: Date.now(),
  };
  await writeSections(brandId, [...sections, section]);
  return section;
}

export async function renameBrandSection(brandId, sectionId, newName) {
  const trimmed = (newName || '').trim();
  if (!trimmed) throw new Error('Section name cannot be empty.');
  const sections = (await getBrandSections(brandId)).map(normalizeSection);
  const updated = sections.map((s) => (s.id === sectionId ? { ...s, name: trimmed } : s));
  await writeSections(brandId, updated);
}

/**
 * Replace the field definitions on a table-kind section. Field ids of
 * fields that survive a rename should be preserved by the caller so
 * existing report values keep their link.
 */
export async function updateBrandSectionFields(brandId, sectionId, fields) {
  const sections = (await getBrandSections(brandId)).map(normalizeSection);
  const target = sections.find((s) => s.id === sectionId);
  if (!target) throw new Error('Section not found.');
  if (target.kind !== 'table') throw new Error('Only table sections have fields.');
  const cleaned = (fields || []).map((f) => ({
    id: f.id || genId(),
    label: String(f.label || '').trim(),
    type: FIELD_TYPES.includes(f.type) ? f.type : 'text',
    options: Array.isArray(f.options)
      ? f.options.map((o) => String(o).trim()).filter(Boolean)
      : [],
  })).filter((f) => f.label);
  if (cleaned.length === 0) throw new Error('A table section needs at least one field.');
  const updated = sections.map((s) => (s.id === sectionId ? { ...s, fields: cleaned } : s));
  await writeSections(brandId, updated);
}

export async function removeBrandSection(brandId, sectionId) {
  const sections = (await getBrandSections(brandId)).map(normalizeSection);
  const updated = sections.filter((s) => s.id !== sectionId);
  await writeSections(brandId, updated);
}
