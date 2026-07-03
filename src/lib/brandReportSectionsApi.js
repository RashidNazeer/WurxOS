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

// ── Report-type scoping (appliesTo) ───────────────────────────────────
// Mirrors brandReportResourcesApi.js exactly so a custom section can be
// limited to specific report types (e.g. a "Paid monthly report" section
// that only shows on monthly reports). Storage: an optional `appliesTo`
// array on each section. A MISSING/empty appliesTo = LEGACY = applies to
// ALL report types (so existing sections keep showing everywhere — no
// behavior change until a section is explicitly scoped).
export const REPORT_TYPES = ['weekly', 'biweekly', 'monthly'];
// New sections default to weekly+monthly (the two report types that render
// brand sections today; biweekly has no brand-section UI). The Add UI lets
// the author narrow it.
const NEW_SECTION_DEFAULT_APPLIES_TO = ['weekly', 'monthly'];

function _normalizeApplies(appliesTo) {
  if (!Array.isArray(appliesTo)) return null;
  const valid = appliesTo.filter((t) => REPORT_TYPES.includes(t));
  return valid.length ? valid : null;
}

// True if a section should render in the given report type. Missing/empty
// appliesTo → legacy → applies to all types.
export function sectionAppliesTo(section, reportType) {
  if (!section) return false;
  if (!REPORT_TYPES.includes(reportType)) return true;
  const arr = _normalizeApplies(section.appliesTo);
  if (!arr) return true;        // legacy → all
  return arr.includes(reportType);
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
  // Canonicalize appliesTo so every read/rewrite auto-heals legacy rows.
  // null (legacy/invalid) is kept as-is → sectionAppliesTo treats it as all.
  return { ...s, kind, fields, appliesTo: _normalizeApplies(s.appliesTo) };
}

export async function addBrandSection(brandId, name, addedByName = '', appliesTo) {
  return addBrandSectionRich(brandId, { name, kind: 'long_text', appliesTo }, addedByName);
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
    appliesTo: _normalizeApplies(payload?.appliesTo) || NEW_SECTION_DEFAULT_APPLIES_TO.slice(),
    addedByName: addedByName || '',
    addedAt: Date.now(),
  };
  await writeSections(brandId, [...sections, section]);
  return section;
}

// Update which report types a section appears in. Must include at least one
// valid type, else we'd hide the section everywhere.
export async function setBrandSectionApplies(brandId, sectionId, appliesTo) {
  const applies = _normalizeApplies(appliesTo);
  if (!applies) throw new Error('Pick at least one report type.');
  const sections = (await getBrandSections(brandId)).map(normalizeSection);
  const updated = sections.map((s) => (s.id === sectionId ? { ...s, appliesTo: applies } : s));
  await writeSections(brandId, updated);
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
