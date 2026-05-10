// ============================================================
// Client report sections — anonymous client-side mutator wrappers.
//
// These wrap the public SECURITY DEFINER RPCs introduced in
// migration 147 (client_section_*). They take an access token as
// the auth proof — no Supabase auth required, suitable for the
// public /portal/access/:token route.
//
// In-app code (Boss/TL/APC) does NOT use these — they read directly
// from brand_report_sections / report_section_values via RLS.
// ============================================================

import { supabase } from './supabase';

function friendly(code) {
  switch (code) {
    case 'access_not_found':    return 'This share link is invalid.';
    case 'access_disabled':     return 'This share link has been disabled.';
    case 'access_revoked':      return 'This share link was revoked.';
    case 'access_expired':      return 'This share link has expired.';
    case 'brand_not_in_token':  return "This section isn't part of your share.";
    case 'section_name_empty':  return 'Section name cannot be empty.';
    case 'section_duplicate':   return 'A section with this name already exists.';
    case 'report_not_found':    return 'That report no longer exists.';
    default: return null;
  }
}

function unwrap(error) {
  if (!error) return null;
  const code = error.message?.match(/access_\w+|brand_not_in_token|section_\w+|report_not_found/)?.[0];
  return Object.assign(new Error(friendly(code) || error.message), { code });
}

export async function clientSectionAdd({ token, brandId, name }) {
  const { data, error } = await supabase.rpc('client_section_add', {
    p_token: token, p_brand_id: brandId, p_name: name,
  });
  if (error) throw unwrap(error);
  return data;  // { id, name, addedAt, addedBy }
}

export async function clientSectionRename({ token, brandId, sectionId, newName }) {
  const { error } = await supabase.rpc('client_section_rename', {
    p_token: token, p_brand_id: brandId, p_section_id: sectionId, p_new_name: newName,
  });
  if (error) throw unwrap(error);
}

export async function clientSectionRemove({ token, brandId, sectionId }) {
  const { error } = await supabase.rpc('client_section_remove', {
    p_token: token, p_brand_id: brandId, p_section_id: sectionId,
  });
  if (error) throw unwrap(error);
}

export async function clientSectionSetValue({ token, reportId, sectionId, sectionName, value }) {
  const { error } = await supabase.rpc('client_section_set_value', {
    p_token: token, p_report_id: reportId,
    p_section_id: sectionId, p_section_name: sectionName,
    p_value: value || '',
  });
  if (error) throw unwrap(error);
}
