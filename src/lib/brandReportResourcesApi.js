// ============================================================
// Brand Report Links — per-brand link sections that auto-render
// in every weekly / bi-weekly / monthly report for the brand.
//
// Storage: brand_report_resources(brand_id, sections jsonb).
// Different from `resources` (per-brand asset list) — these are
// auto-rendered link content shared across every report for the
// brand. See migration 103.
// ============================================================

import { supabase } from './supabase';

function genId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

// Fetch the section list for a brand. Returns [] when the brand has none.
export async function getBrandReportResources(brandId) {
  if (!brandId) return [];
  const { data, error } = await supabase
    .from('brand_report_resources')
    .select('sections')
    .eq('brand_id', brandId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data?.sections || [];
}

// Internal — overwrite the whole sections array for a brand.
async function writeSections(brandId, sections) {
  const { error } = await supabase
    .from('brand_report_resources')
    .upsert({ brand_id: brandId, sections }, { onConflict: 'brand_id' });
  if (error) throw new Error(error.message);
}

// Add a new named section. Throws on duplicate name.
export async function addReportSection(brandId, name) {
  const trimmed = (name || '').trim();
  if (!brandId || !trimmed) throw new Error('Brand and section name are required.');
  const sections = await getBrandReportResources(brandId);
  if (sections.some((s) => (s.name || '').toLowerCase() === trimmed.toLowerCase())) {
    throw new Error('A section with this name already exists for this brand.');
  }
  const section = { id: genId('rs'), name: trimmed, links: [], addedAt: Date.now() };
  await writeSections(brandId, [...sections, section]);
  return section;
}

export async function renameReportSection(brandId, sectionId, newName) {
  const trimmed = (newName || '').trim();
  if (!trimmed) throw new Error('Section name cannot be empty.');
  const sections = await getBrandReportResources(brandId);
  const updated = sections.map((s) => (s.id === sectionId ? { ...s, name: trimmed } : s));
  await writeSections(brandId, updated);
}

export async function removeReportSection(brandId, sectionId) {
  const sections = await getBrandReportResources(brandId);
  const updated = sections.filter((s) => s.id !== sectionId);
  await writeSections(brandId, updated);
}

// Add a link inside a named section.
export async function addReportLink(brandId, sectionId, label, url) {
  const lbl = (label || '').trim();
  const u   = (url   || '').trim();
  if (!lbl) throw new Error('Label is required.');
  if (!u)   throw new Error('URL is required.');
  if (!/^https?:\/\//i.test(u)) throw new Error('URL must start with http:// or https://');
  const sections = await getBrandReportResources(brandId);
  const link = { id: genId('rl'), label: lbl, url: u, addedAt: Date.now() };
  const updated = sections.map((s) => (s.id === sectionId
    ? { ...s, links: [...(s.links || []), link] }
    : s));
  await writeSections(brandId, updated);
  return link;
}

export async function updateReportLink(brandId, sectionId, linkId, label, url) {
  const lbl = (label || '').trim();
  const u   = (url   || '').trim();
  if (!lbl) throw new Error('Label is required.');
  if (!u)   throw new Error('URL is required.');
  if (!/^https?:\/\//i.test(u)) throw new Error('URL must start with http:// or https://');
  const sections = await getBrandReportResources(brandId);
  const updated = sections.map((s) => {
    if (s.id !== sectionId) return s;
    return {
      ...s,
      links: (s.links || []).map((l) => (l.id === linkId ? { ...l, label: lbl, url: u } : l)),
    };
  });
  await writeSections(brandId, updated);
}

export async function removeReportLink(brandId, sectionId, linkId) {
  const sections = await getBrandReportResources(brandId);
  const updated = sections.map((s) => {
    if (s.id !== sectionId) return s;
    return { ...s, links: (s.links || []).filter((l) => l.id !== linkId) };
  });
  await writeSections(brandId, updated);
}
