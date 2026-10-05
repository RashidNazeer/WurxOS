// READ-ONLY data profiler for the Assistant architecture (Phase 0 inventory).
// Prints aggregates only — counts, field shapes, text sizes, number formats —
// never salaries or personal fields. Reads the DEV project from .env.dev.
//   node Assistant/scripts/profile-data.mjs > Assistant/inventory.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(REPO, 'package.json'));
const { createClient } = require('@supabase/supabase-js');

const env = Object.fromEntries(fs.readFileSync(path.join(REPO, '.env.dev'), 'utf8').split(/\r?\n/)
  .filter((l) => l.includes('=') && !l.startsWith('#'))
  .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
const sb = createClient(env.VITE_SUPABASE_URL, env.WURXOS_DEV_SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const out = {};
async function count(table, filter) {
  let q = sb.from(table).select('*', { count: 'exact', head: true });
  if (filter) q = filter(q);
  const { count: c, error } = await q;
  return error ? `ERR ${error.code || ''} ${error.message.slice(0, 60)}` : c;
}
async function all(table, cols, filter) {
  const rows = []; const size = 1000;
  for (let from = 0; ; from += size) {
    let q = sb.from(table).select(cols).range(from, from + size - 1);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) return { error: error.message };
    rows.push(...data); if (data.length < size) break;
  }
  return rows;
}
const stats = (arr) => {
  const a = arr.filter((n) => n > 0).sort((x, y) => x - y);
  if (!a.length) return { n: 0 };
  const sum = a.reduce((s, x) => s + x, 0);
  return { n: a.length, sum, avg: Math.round(sum / a.length), p50: a[Math.floor(a.length * .5)], p95: a[Math.floor(a.length * .95)], max: a[a.length - 1] };
};
const tally = (arr) => arr.reduce((m, k) => (m[k] = (m[k] || 0) + 1, m), {});
const strip = (s) => String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const shape = (v) => String(v).replace(/[0-9]/g, '9').replace(/9+/g, '9').slice(0, 20);

// 1. Row counts across candidate tables
const TABLES = ['reports', 'gmv_max_reports', 'kb_articles', 'ai_assistant_docs', 'tts_knowledge', 'brands', 'profiles',
  'agenda_meetings', 'agenda_tasks', 'agenda_presentations', 'agenda_task_reviews', 'agenda_resources', 'brand_monthly_metrics',
  'incentives', 'performance_ratings', 'performance_flags', 'attendance', 'attendance_sessions', 'leave_requests', 'employee_compensation',
  'salary_history', 'broadcasts', 'product_campaigns', 'campaigns', 'tasks', 'bug_reports', 'suggestions', 'resources', 'reminders',
  'paid_collab_brands', 'paid_collab_creators', 'paid_collab_videos', 'brand_report_sections', 'brand_report_resources',
  'ai_conversations', 'ai_messages', 'notifications', 'chat_messages', 'euka_shop_metrics', 'weekly_performance_ratings', 'kb_comments', 'change_requests'];
out.counts = {};
for (const t of TABLES) out.counts[t] = await count(t);

// 2. Reports deep profile
const reps = await all('reports', 'id, type, status, period_start, period_end, brand_id, sections_enabled, data');
if (reps.error) out.reports = reps; else {
  const r = {};
  r.total = reps.length;
  r.byTypeStatus = tally(reps.map((x) => `${x.type}/${x.status}`));
  r.periodRange = { min: reps.map((x) => x.period_start).sort()[0], max: reps.map((x) => x.period_start).sort().at(-1) };
  r.byYearMonth = tally(reps.map((x) => String(x.period_start).slice(0, 7)));
  r.brandsWithReports = new Set(reps.map((x) => x.brand_id)).size;
  r.layout = tally(reps.map((x) => x.type === 'monthly' ? 'monthly' : (x.data?.insightsSingle === true ? 'weekly-single' : `${x.type}-legacy`)));
  r.currency = tally(reps.map((x) => x.data?.currency ?? '(missing)'));
  r.sectionsEnabledNonEmpty = reps.filter((x) => x.sections_enabled && Object.keys(x.sections_enabled).length).length;
  // key frequency per type
  r.keysByType = {};
  for (const t of ['weekly', 'biweekly', 'monthly']) {
    const sub = reps.filter((x) => x.type === t);
    r.keysByType[t] = tally(sub.flatMap((x) => Object.keys(x.data || {})));
  }
  // text fields: size + html presence
  const TEXT = ['reportInsights', 'overallInsights', 'topCreatorsInsights', 'topVideosInsights', 'gmvMaxInsights', 'productHighlightsInsights',
    'offsiteInsights', 'upcomingCampaigns', 'operationalUpdates', 'recommendations', 'actionItems', 'keyWinsInsights', 'campaignsText'];
  r.textFields = {};
  for (const k of TEXT) {
    const vals = reps.map((x) => x.data?.[k]).filter((v) => typeof v === 'string' && strip(v).length > 3);
    r.textFields[k] = { filled: vals.length, html: vals.filter((v) => /<[a-z][^>]*>/i.test(v)).length, chars: stats(vals.map((v) => strip(v).length)) };
  }
  // table sizes
  const ARR = ['topCreators', 'topVideos', 'gmvMax', 'gmvMaxMtd', 'productHighlights', 'productAnalytics'];
  r.tables = {};
  for (const k of ARR) {
    const lens = reps.map((x) => Array.isArray(x.data?.[k]) ? x.data[k].filter((row) => row && Object.values(row).some((v) => String(v ?? '').trim())).length : 0);
    r.tables[k] = stats(lens);
    const notes = reps.flatMap((x) => Array.isArray(x.data?.[k]) ? x.data[k].map((row) => strip(row?.notes)) : []).filter((s) => s.length > 3);
    r.tables[k].notesFilled = notes.length; r.tables[k].notesChars = stats(notes.map((s) => s.length));
  }
  // custom fields
  r.customFields = stats(reps.map((x) => Object.keys(x.data?.customFields || {}).length));
  // number format shapes
  const gmvVals = reps.flatMap((x) => [x.data?.overallPerformance?.gmv, x.data?.keyMetrics?.gmv, x.data?.overallPerformance?.roi]).filter((v) => v != null && String(v).trim());
  r.numberShapes = Object.entries(tally(gmvVals.map(shape))).sort((a, b) => b[1] - a[1]).slice(0, 15);
  r.numberExamples = [...new Set(gmvVals.map(String))].slice(0, 12);
  // total indexable text volume
  const totalChars = reps.reduce((s, x) => s + strip(JSON.stringify(x.data || {})).length, 0);
  r.totalJsonTextChars = totalChars;
  r.estTokensAll = Math.round(totalChars / 4);
  r.indexable = reps.filter((x) => x.status !== 'draft').length;
  out.reports = r;
}

// 3. KB
const kb = await all('kb_articles', 'id, title, body, url, category, visibility, visible_to_roles, visible_to_users, approval_status, sop_group_id, version, tags');
if (kb.error) out.kb = kb; else {
  const latest = new Map();
  for (const a of kb.sort((x, y) => (y.version || 1) - (x.version || 1))) { const k = a.sop_group_id || a.id; if (!latest.has(k)) latest.set(k, a); }
  const L = [...latest.values()];
  out.kb = {
    total: kb.length, latestPerGroup: L.length,
    approval: tally(kb.map((a) => a.approval_status)), visibility: tally(L.map((a) => a.visibility)),
    category: tally(L.map((a) => a.category)),
    bodyEmpty_urlOnly: L.filter((a) => strip(a.body).length < 20 && a.url).length,
    bodyFilled: L.filter((a) => strip(a.body).length >= 20).length,
    neither: L.filter((a) => strip(a.body).length < 20 && !a.url).length,
    bodyChars: stats(L.map((a) => strip(a.body).length)),
    urlHosts: tally(L.filter((a) => a.url).map((a) => { try { return new URL(a.url).host; } catch { return 'invalid'; } })),
    rolesUsed: tally(L.flatMap((a) => a.visible_to_roles || [])),
  };
}

// 4. ai_assistant_docs
const docs = await all('ai_assistant_docs', 'id, title, content, is_active');
out.aiDocs = docs.error ? docs : { total: docs.length, active: docs.filter((d) => d.is_active).length,
  chars: stats(docs.map((d) => (d.content || '').length)), sopImports: docs.filter((d) => /wurx-sop-import/.test(d.content || '')).length,
  titles: docs.slice(0, 40).map((d) => d.title) };

// 5. TikTok knowledge
const tts = await all('tts_knowledge', 'knowledge_id, chunk_index, content_type, category, chunk_text, token_estimate, is_active, breadcrumb');
out.tts = tts.error ? tts : { chunks: tts.length, articles: new Set(tts.map((t) => t.knowledge_id)).size,
  contentType: tally(tts.map((t) => t.content_type)), category: tally(tts.map((t) => t.category || '(none)')),
  topBreadcrumbs: Object.entries(tally(tts.map((t) => String(t.breadcrumb || '').split('>')[0].trim()))).sort((a, b) => b[1] - a[1]).slice(0, 12),
  chunkChars: stats(tts.map((t) => (t.chunk_text || '').length)), active: tts.filter((t) => t.is_active).length };
const embNull = await count('tts_knowledge', (q) => q.is('embedding', null));
out.tts.embeddingNull = embNull;

// 6. GMV Max reports
const gm = await all('gmv_max_reports', 'period, period_start, currency, notes, campaigns');
out.gmvMax = gm.error ? gm : { total: gm.length, period: tally(gm.map((g) => g.period)), currency: tally(gm.map((g) => g.currency)),
  notesFilled: gm.filter((g) => strip(g.notes).length > 3).length, campaigns: stats(gm.map((g) => (g.campaigns || []).length)),
  range: [gm.map((g) => g.period_start).sort()[0], gm.map((g) => g.period_start).sort().at(-1)] };

// 7. Agenda text volume
const at = await all('agenda_tasks', 'status, details, brand_id');
out.agendaTasks = at.error ? at : { total: at.length, status: tally(at.map((t) => t.status)), detailsFilled: at.filter((t) => strip(t.details).length > 3).length, detailsChars: stats(at.map((t) => strip(t.details).length)), withBrand: at.filter((t) => t.brand_id).length };
const ap = await all('agenda_presentations', 'overall_summary, overall_rating');
out.agendaPresentations = ap.error ? ap : { total: ap.length, summaryFilled: ap.filter((p) => strip(p.overall_summary).length > 3).length, chars: stats(ap.map((p) => strip(p.overall_summary).length)) };

// 8. Brands / people (counts only)
const br = await all('brands', 'status, tier');
out.brands = br.error ? br : { total: br.length, status: tally(br.map((b) => b.status)), tier: tally(br.map((b) => b.tier || '(none)')) };
const pr = await all('profiles', 'role, is_active, deleted_at');
out.profiles = pr.error ? pr : { byRole: tally(pr.filter((p) => !p.deleted_at && p.is_active !== false).map((p) => p.role)), inactiveOrDeleted: pr.filter((p) => p.deleted_at || p.is_active === false).length };

// 9. Assistant usage so far
const cfg = await sb.from('ai_assistant_config').select('model, enabled, use_kb, use_tts_academy').eq('id', 1).maybeSingle();
out.aiConfig = cfg.data || cfg.error?.message;

console.log(JSON.stringify(out, null, 1));

