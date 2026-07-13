// ============================================================
// Report Section Presets — save a report section's content as a reusable,
// named preset and restore it into a later report of the same type.
//
// Scope: per BRAND, per REPORT TYPE, per SECTION. Presets are SHARED within a
// brand (same brand-scoped model as brand_report_sections) and can never leak
// across brands — every query filters by brand_id and RLS enforces it too.
// See migration 241.
//
// `sectionKey`:
//   • hardcoded section → the report data key ('gmvMax', 'topCreators', …)
//   • custom section    → the section's opaque id ('cs_…')
//
// `payload` shapes (built/consumed by SectionPresetBar):
//   rows:   { kind:'rows',   fields:[key,…], rows:[{…},…] }
//   object: { kind:'object', fields:[key,…], values:{…} }
//   text:   { kind:'text',   html:'<p>…</p>' }
// ============================================================

import { supabase } from './supabase';

// List every preset saved for a section (a brand + report type + section),
// newest first. Returns [] on error so the UI degrades gracefully.
export async function listSectionPresets(brandId, reportType, sectionKey) {
  if (!brandId || !reportType || !sectionKey) return [];
  const { data, error } = await supabase
    .from('report_section_presets')
    .select('id, name, payload, created_by, created_at, updated_at')
    .eq('brand_id', brandId)
    .eq('report_type', reportType)
    .eq('section_key', sectionKey)
    .order('updated_at', { ascending: false });
  if (error) { console.error('listSectionPresets failed', error); return []; }
  return data || [];
}

// Load EVERY preset for a brand + report type in one query (all sections),
// grouped by section_key — so a form fetches presets once instead of once per
// section. Returns {} on error.
export async function listSectionPresetsForType(brandId, reportType) {
  if (!brandId || !reportType) return {};
  const { data, error } = await supabase
    .from('report_section_presets')
    .select('id, section_key, name, payload, created_by, created_at, updated_at')
    .eq('brand_id', brandId)
    .eq('report_type', reportType)
    .order('updated_at', { ascending: false });
  if (error) { console.error('listSectionPresetsForType failed', error); return {}; }
  const bySection = {};
  for (const row of data || []) {
    (bySection[row.section_key] || (bySection[row.section_key] = [])).push(row);
  }
  return bySection;
}

// Save (create or overwrite-by-name) a preset. The unique index on
// (brand_id, report_type, section_key, name) means re-saving under the same
// name UPDATES that preset rather than creating a duplicate.
export async function saveSectionPreset({ brandId, reportType, sectionKey, name, payload, uid }) {
  const trimmed = String(name || '').trim();
  if (!brandId || !reportType || !sectionKey) throw new Error('Missing brand / report type / section.');
  if (!trimmed) throw new Error('Give the preset a name.');
  const row = {
    brand_id: brandId,
    report_type: reportType,
    section_key: sectionKey,
    name: trimmed,
    payload: payload || {},
    created_by: uid || null,
  };
  const { data, error } = await supabase
    .from('report_section_presets')
    .upsert(row, { onConflict: 'brand_id,report_type,section_key,name' })
    .select('id, name, payload, created_by, created_at, updated_at')
    .single();
  if (error) throw error;
  return data;
}

// Delete a single preset by id.
export async function deleteSectionPreset(id) {
  if (!id) return;
  const { error } = await supabase.from('report_section_presets').delete().eq('id', id);
  if (error) throw error;
}

// Delete EVERY preset tied to a section (all report types) for a brand. Called
// when a custom section is deleted — since custom sections aren't DB rows there
// is no FK cascade, so the cascade is done here explicitly. Returns the number
// deleted so the caller can tell the user what was removed.
export async function deleteSectionPresetsForSection(brandId, sectionKey) {
  if (!brandId || !sectionKey) return 0;
  const { data, error } = await supabase
    .from('report_section_presets')
    .delete()
    .eq('brand_id', brandId)
    .eq('section_key', sectionKey)
    .select('id');
  if (error) { console.error('deleteSectionPresetsForSection failed', error); return 0; }
  return (data || []).length;
}

// Count presets tied to a section (all report types) for a brand — used to warn
// the user, before deleting a custom section, how many presets will be lost.
export async function countSectionPresetsForSection(brandId, sectionKey) {
  if (!brandId || !sectionKey) return 0;
  const { count, error } = await supabase
    .from('report_section_presets')
    .select('id', { count: 'exact', head: true })
    .eq('brand_id', brandId)
    .eq('section_key', sectionKey);
  if (error) { console.error('countSectionPresetsForSection failed', error); return 0; }
  return count || 0;
}
