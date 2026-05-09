import { supabase } from './supabase';

// ----------------------------------------------------------------
// Smart source detection (mirrors v1 — Google suite, Figma, Notion,
// Dropbox, YouTube, Vimeo + bare image / video / pdf / file).
// ----------------------------------------------------------------
const PLATFORM_RULES = [
  { match: /docs\.google\.com\/document/i,     source: 'google_docs',   label: 'Google Docs',   type: 'link' },
  { match: /docs\.google\.com\/spreadsheets/i, source: 'google_sheets', label: 'Google Sheets', type: 'link' },
  { match: /docs\.google\.com\/presentation/i, source: 'google_slides', label: 'Google Slides', type: 'link' },
  { match: /drive\.google\.com/i,              source: 'google_drive',  label: 'Google Drive',  type: 'link' },
  { match: /(?:youtube\.com|youtu\.be)/i,      source: 'youtube',       label: 'YouTube',       type: 'video' },
  { match: /vimeo\.com/i,                      source: 'vimeo',         label: 'Vimeo',         type: 'video' },
  { match: /tiktok\.com/i,                     source: 'tiktok',        label: 'TikTok',        type: 'video' },
  { match: /figma\.com/i,                      source: 'figma',         label: 'Figma',         type: 'link' },
  { match: /notion\.so/i,                      source: 'notion',        label: 'Notion',        type: 'link' },
  { match: /dropbox\.com/i,                    source: 'dropbox',       label: 'Dropbox',       type: 'link' },
];

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)(\?.*)?$/i;
const VIDEO_EXT = /\.(mp4|mov|webm|m4v|mkv|avi)(\?.*)?$/i;
const FILE_EXT  = /\.(pdf|docx?|xlsx?|pptx?|csv|zip|rar|7z|txt|md)(\?.*)?$/i;

export function detectSource(url = '') {
  const u = String(url).trim();
  if (!u) return { type: 'link', source: 'link', label: 'Link' };

  for (const rule of PLATFORM_RULES) {
    if (rule.match.test(u)) return { type: rule.type, source: rule.source, label: rule.label };
  }

  if (IMAGE_EXT.test(u)) return { type: 'image', source: 'image', label: 'Image' };
  if (VIDEO_EXT.test(u)) return { type: 'video', source: 'video', label: 'Video' };
  if (FILE_EXT.test(u))  return { type: 'file',  source: 'file',  label: 'File' };
  return { type: 'link', source: 'link', label: 'Link' };
}

// Convenience used by the existing migration (just the type slot).
export function detectType(url) { return detectSource(url).type; }

// ----------------------------------------------------------------
// Thumbnails
// ----------------------------------------------------------------
export function getYouTubeThumbnail(url) {
  if (!url) return null;
  const s = String(url);
  let id = null;
  let m = s.match(/[?&]v=([A-Za-z0-9_-]{6,})/);    if (m) id = m[1];
  if (!id) { m = s.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/); if (m) id = m[1]; }
  if (!id) { m = s.match(/youtube\.com\/embed\/([A-Za-z0-9_-]{6,})/); if (m) id = m[1]; }
  if (!id) { m = s.match(/youtube\.com\/shorts\/([A-Za-z0-9_-]{6,})/); if (m) id = m[1]; }
  return id ? `https://img.youtube.com/vi/${id}/mqdefault.jpg` : null;
}

export function thumbnailFor(resource) {
  if (!resource) return null;
  const src = detectSource(resource.url);
  if (src.source === 'youtube') return getYouTubeThumbnail(resource.url);
  if (resource.type === 'image') return resource.url;
  return null;
}

// ----------------------------------------------------------------
// Time-relative helper used by the brand-tab variant.
// ----------------------------------------------------------------
export function timeAgo(d) {
  if (!d) return '';
  const date = new Date(d);
  const ms = Date.now() - date.getTime();
  const day = 86400000;
  if (ms < day && date.toDateString() === new Date().toDateString()) return 'Today';
  const days = Math.floor(ms / day);
  if (days <= 1) return 'Yesterday';
  if (days <  7) return `${days}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ----------------------------------------------------------------
// CRUD
// ----------------------------------------------------------------
export async function listResources({ brandId = null, type = null, scope = null } = {}) {
  let q = supabase
    .from('resources')
    .select('*, brand:brand_id(id, brand_name, logo_url), creator:created_by(id, display_name, role)')
    .order('created_at', { ascending: false });
  if (brandId)            q = q.eq('brand_id', brandId);
  if (type && type !== 'all') q = q.eq('type', type);
  if (scope === 'brand')   q = q.not('brand_id', 'is', null);
  if (scope === 'general') q = q.is('brand_id', null);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data || [];
}

export async function createResource(input) {
  const me = (await supabase.auth.getUser()).data?.user;
  const detected = detectSource(input.url || '');
  const row = {
    brand_id:        input.brandId        || null,
    type:            input.type           || detected.type,
    name:            (input.name || '').trim(),
    url:             (input.url  || '').trim(),
    description:     (input.description || '').trim(),
    visibility:      input.visibility     || (input.brandId ? 'office' : 'office'),
    visible_to_uid:  input.visibility === 'user'  ? (input.visibleToUid || null) : null,
    visible_to_roles: input.visibility === 'group' ? (input.visibleToRoles || []) : [],
    created_by:      me?.id,
    // Opt-in — the DB trigger only fans out if the caller ticks the
    // "notify people" checkbox in the modal.
    notify:          !!input.notify,
  };
  const { data, error } = await supabase.from('resources').insert(row).select().single();
  if (error) throw new Error(error.message);
  return data;
}

export async function updateResource(id, patch) {
  const detected = patch.url ? detectSource(patch.url) : null;
  // Always reset notify to false on update unless the caller opts in
  // explicitly — a silent edit should never spam recipients.
  const row = { notify: !!patch.notify };
  if ('name' in patch)        row.name        = (patch.name || '').trim();
  if ('url' in patch)         row.url         = (patch.url  || '').trim();
  if ('description' in patch) row.description = (patch.description || '').trim();
  if ('type' in patch)        row.type        = patch.type;
  else if (detected)          row.type        = detected.type;
  if ('brandId' in patch)     row.brand_id    = patch.brandId || null;
  if ('visibility' in patch) {
    row.visibility       = patch.visibility;
    row.visible_to_uid   = patch.visibility === 'user'  ? (patch.visibleToUid || null) : null;
    row.visible_to_roles = patch.visibility === 'group' ? (patch.visibleToRoles || []) : [];
  }
  const { data, error } = await supabase.from('resources').update(row).eq('id', id).select().single();
  if (error) throw new Error(error.message);
  return data;
}

export async function deleteResource(id) {
  const { error } = await supabase.from('resources').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

// "Added by" filter helpers
export function uniqueCreators(rows) {
  const map = new Map();
  for (const r of rows) {
    if (r.creator?.id && !map.has(r.creator.id)) {
      map.set(r.creator.id, { id: r.creator.id, display_name: r.creator.display_name, role: r.creator.role });
    }
  }
  return Array.from(map.values()).sort((a, b) => (a.display_name || '').localeCompare(b.display_name || ''));
}

// Date-range filter helper for the brand-tab variant
export function inDateRange(d, range, custom) {
  if (range === 'any') return true;
  const dt = new Date(d).getTime();
  const now = new Date();
  const startOfDay = (x) => { const c = new Date(x); c.setHours(0,0,0,0); return c.getTime(); };
  if (range === 'today') return dt >= startOfDay(now);
  if (range === 'week') {
    const w = new Date(now); w.setDate(w.getDate() - 7);
    return dt >= w.getTime();
  }
  if (range === 'month') {
    const m = new Date(now); m.setMonth(m.getMonth() - 1);
    return dt >= m.getTime();
  }
  if (range === 'custom' && custom?.from && custom?.to) {
    const fromMs = startOfDay(custom.from);
    const toMs   = startOfDay(custom.to) + 86400000;
    return dt >= fromMs && dt < toMs;
  }
  return true;
}
