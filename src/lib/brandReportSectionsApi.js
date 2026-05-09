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

export async function addBrandSection(brandId, name, addedByName = '') {
  const trimmed = (name || '').trim();
  if (!brandId || !trimmed) throw new Error('Brand and section name are required.');
  const sections = await getBrandSections(brandId);
  if (sections.some((s) => (s.name || '').toLowerCase() === trimmed.toLowerCase())) {
    throw new Error('A section with this name already exists for this brand.');
  }
  const section = {
    id: genId(),
    name: trimmed,
    addedByName: addedByName || '',
    addedAt: Date.now(),
  };
  await writeSections(brandId, [...sections, section]);
  return section;
}

export async function renameBrandSection(brandId, sectionId, newName) {
  const trimmed = (newName || '').trim();
  if (!trimmed) throw new Error('Section name cannot be empty.');
  const sections = await getBrandSections(brandId);
  const updated = sections.map((s) => (s.id === sectionId ? { ...s, name: trimmed } : s));
  await writeSections(brandId, updated);
}

export async function removeBrandSection(brandId, sectionId) {
  const sections = await getBrandSections(brandId);
  const updated = sections.filter((s) => s.id !== sectionId);
  await writeSections(brandId, updated);
}
