// ============================================================
// TikTok Shop Academy (US) — full-catalog crawler.
//
// Discovery: the Academy's own sitemap API (every public US page), plus any
// prev/next/recommended links seen while crawling as a safety net.
// Content: the JSON the server embeds in each page (window._ROUTER_DATA) —
// plain text, section trail, keywords, modify_time — never HTML scraping.
//
//   essay  → one article per page (knowledge_plain_content)
//   course → ONE fetch returns every lesson of the course (course_contents)
//
// The login-only /ai-university front end is not needed: it sits on the same
// knowledge base, which the public Academy serves.
//
// The Academy throttles bursty clients and sometimes serves a JS-only shell
// instead of the rendered page. A shell is TRANSIENT (retried with backoff);
// only the "content does not exist" page is treated as dead.
//
// Output (gitignored): Assistant/data/tts-academy/
//   articles.jsonl   one record per article / course lesson
//   crawl-report.json  counts, dead ids, failures
// Resumable: ids already in articles.jsonl are skipped (use --refresh to redo).
//
//   node Assistant/scripts/tts-crawl.mjs              # full crawl
//   node Assistant/scripts/tts-crawl.mjs --limit 10   # smoke test
//   node Assistant/scripts/tts-crawl.mjs --kind course --limit 2
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = path.join(ROOT, 'Assistant', 'data', 'tts-academy');
const OUT_FILE = path.join(OUT_DIR, 'articles.jsonl');
const REPORT_FILE = path.join(OUT_DIR, 'crawl-report.json');

const BASE = 'https://seller-us.tiktok.com';
const SITEMAP = `${BASE}/api/v1/seller/learning_center/sitemap/urls/get?version=1&region=US`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

const args = process.argv.slice(2);
const LIMIT = (() => { const i = args.indexOf('--limit'); return i >= 0 ? Number(args[i + 1]) : Infinity; })();
const REFRESH = args.includes('--refresh');
const KIND = (() => { const i = args.indexOf('--kind'); return i >= 0 ? args[i + 1] : null; })();   // 'essay' | 'course'
const DELAY_MS = 2500;          // base gap between requests
const JITTER_MS = 1000;
const MAX_ATTEMPTS = 6;         // per page
const BACKOFF_MS = [5000, 15000, 30000, 60000, 120000];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const now = () => new Date().toISOString();
const toIso = (t) => {
  const n = Number(t);
  if (!n) return null;
  return new Date(n > 1e12 ? n : n * 1000).toISOString();   // essays use seconds, courses ms
};

// ── text helpers ────────────────────────────────────────────────────
const decode = (s) => s
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#x27;|&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
const clean = (s) => decode(String(s || ''))
  .replace(/​|‌|‍|﻿/g, '')
  .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const htmlToText = (html) => clean(String(html || '')
  .replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '')
  .replace(/<li[^>]*>/gi, '\n• ').replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/(p|div|h[1-6]|tr|li|section|article|table)>/gi, '\n')
  .replace(/<[^>]+>/g, ''));
// Quill-style delta JSON ({"deltas":{"0":{"ops":[{"insert":"..."}]}}}) → text
const deltaToText = (raw) => {
  try {
    const j = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const parts = [];
    for (const d of Object.values(j?.deltas || {})) for (const op of d?.ops || []) if (typeof op.insert === 'string') parts.push(op.insert);
    return clean(parts.join(''));
  } catch { return ''; }
};

// ── fetching ────────────────────────────────────────────────────────
let lastRequest = 0;
async function politeFetch(url, accept = 'text/html') {
  const wait = lastRequest + DELAY_MS + Math.random() * JITTER_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequest = Date.now();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en', Accept: accept }, signal: ctrl.signal });
    return { status: res.status, text: await res.text() };
  } finally { clearTimeout(t); }
}

const routerData = (html) => {
  const m = html.match(/window\._ROUTER_DATA\s*=\s*([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1].trim().replace(/;\s*$/, '')); } catch { return null; }
};
const isDead = (html) => /The content (you are looking for )?does not exist/i.test(html);

// Fetch a page until we get the server-rendered JSON. Returns
// { ok, data } | { dead:true } | { ok:false, reason }.
async function fetchPage(url, routeKey) {
  let reason = 'unknown';
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]);
    let r;
    try { r = await politeFetch(url); }
    catch (e) { reason = e.name === 'AbortError' ? 'timeout' : (e.cause?.code || e.message || 'fetch error'); continue; }
    if (r.status === 404 || isDead(r.text)) return { dead: true };
    if (r.status >= 400) { reason = `HTTP ${r.status}`; continue; }
    const d = routerData(r.text);
    const page = d?.loaderData?.[routeKey];
    if (page) return { ok: true, data: page };
    reason = d ? `no ${routeKey} data` : 'js-only shell';     // transient
  }
  return { ok: false, reason: `${reason} (after ${MAX_ATTEMPTS} attempts)` };
}

// ── parsing ─────────────────────────────────────────────────────────
function trailOf(tree, id) {
  const target = String(id);
  const walk = (n, trail) => {
    if (String(n.content_id) === target) return trail;
    for (const k of n.sub_contents || []) { const r = walk(k, [...trail, n.content_name]); if (r) return r; }
    return null;
  };
  return tree ? (walk(tree, []) || []) : [];
}

function linkedIds(p) {
  const ids = [];
  for (const k of ['prev_knowledge', 'next_knowledge']) if (p[k]?.learning_type === 2 && p[k].learning_id) ids.push(String(p[k].learning_id));
  for (const r of p.rec_content || []) if (r?.learning_type === 2 && r.learning_id) ids.push(String(r.learning_id));
  const walk = (n) => { if (n.content_type === 2) ids.push(String(n.content_id)); (n.sub_contents || []).forEach(walk); };
  if (p.sidebar_contents) walk(p.sidebar_contents);
  return ids;
}

function parseEssay(p, url) {
  const kd = p.knowledge_detail || {};
  const li = p.learning_info || {};
  const text = clean(kd.knowledge_plain_content) || htmlToText(p.knowledge_content);
  const trail = trailOf(p.sidebar_contents, kd.knowledge_id);
  return {
    id: String(kd.knowledge_id || li.learning_id),
    kind: 'essay',
    url: p.canonical_url || url,
    title: clean(kd.knowledge_name || li.name),
    breadcrumb: trail.join(' > '),
    keywords: (kd.keywords || '').split(',').map((s) => s.trim()).filter(Boolean),
    applies_to: p.country_scope_info?.tag_text || null,
    source: (p.sources || []).map((s) => s.source_name).filter(Boolean)[0] || null,
    ai_summary: li.active_ai_summary?.active ? clean(li.active_ai_summary.text) : (li.ai_summary ? clean(li.ai_summary) : null),
    toc: (p.toc_list || []).map((t) => ({ level: t.level, text: clean(t.text) })),
    text,
    views: li.views ?? null,
    created_at: toIso(li.create_time),
    modified_at: toIso(li.modify_time),
  };
}

function parseCourse(p, learningId) {
  const info = p.course_detail?.info || p.learning_info || {};
  const lessons = p.course_contents || p.course_detail?.course || [];
  return lessons.map((l, i) => {
    const k = l.knowledge || {};
    const id = String(k.knowledge_id || l.content_id);
    const isCurrent = String(p.current_content_item?.content_id) === id;
    const text = deltaToText(k.knowledge_content) || (isCurrent ? htmlToText(p.knowledge_content) : '');
    return {
      id,
      kind: 'course_lesson',
      url: `${BASE}/university/course?learning_id=${learningId}&content_id=${id}&lang=en`,
      title: clean(k.knowledge_name || l.content_name),
      breadcrumb: `Courses > ${clean(info.name)}`,
      course: { learning_id: String(learningId), name: clean(info.name), description: clean(info.description), lesson_index: i, lesson_count: lessons.length },
      keywords: (k.keywords || '').split(',').map((s) => s.trim()).filter(Boolean),
      applies_to: null,
      source: (p.sources || []).map((s) => s.source_name).filter(Boolean)[0] || null,
      ai_summary: null,
      toc: [],
      text,
      lesson_type: l.type ?? null,
      views: info.views ?? null,
      created_at: toIso(info.create_time),
      modified_at: toIso(info.modify_time),
    };
  });
}

// ── main ────────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const done = new Set();
  if (!REFRESH && fs.existsSync(OUT_FILE)) {
    for (const line of fs.readFileSync(OUT_FILE, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); done.add(`${r.kind === 'course_lesson' ? 'course:' + r.course.learning_id : 'essay:' + r.id}`); } catch { /* skip */ }
    }
  } else if (REFRESH && fs.existsSync(OUT_FILE)) fs.renameSync(OUT_FILE, OUT_FILE + '.bak');

  console.log('Fetching sitemap…');
  const sm = await politeFetch(SITEMAP, 'application/json');
  const entries = JSON.parse(sm.text)?.data || [];
  const essays = new Map();   // id -> url
  const courses = new Map();  // learning_id -> url
  for (const { loc } of entries) {
    const u = new URL(loc);
    if (u.pathname.endsWith('/essay')) essays.set(u.searchParams.get('knowledge_id'), `${BASE}/university/essay?knowledge_id=${u.searchParams.get('knowledge_id')}&lang=en`);
    else if (u.pathname.endsWith('/course')) {
      const lid = u.searchParams.get('learning_id');
      if (!courses.has(lid)) courses.set(lid, `${BASE}/university/course?learning_id=${lid}&content_id=${u.searchParams.get('content_id')}&lang=en`);
    }
  }
  console.log(`Sitemap: ${entries.length} URLs → ${essays.size} essays, ${courses.size} courses. Already done: ${done.size}\n`);

  const out = fs.createWriteStream(OUT_FILE, { flags: 'a' });
  const write = (rec) => { rec.content_hash = sha(`${rec.title}\n${rec.text}`); rec.fetched_at = now(); out.write(JSON.stringify(rec) + '\n'); };
  const report = { started_at: now(), sitemap_urls: entries.length, essays_in_sitemap: essays.size, courses_in_sitemap: courses.size,
    essays_ok: 0, lessons_ok: 0, discovered_outside_sitemap: 0, empty_text: [], dead: [], failed: [] };

  const queue = [];
  if (KIND !== 'course') for (const id of essays.keys()) queue.push({ type: 'essay', id });
  if (KIND !== 'essay') for (const lid of courses.keys()) queue.push({ type: 'course', id: lid });
  const seen = new Set(queue.map((q) => `${q.type}:${q.id}`));
  let processed = 0;

  while (queue.length && processed < LIMIT) {
    const item = queue.shift();
    const key = `${item.type}:${item.id}`;
    if (done.has(key)) continue;
    processed++;
    const url = item.type === 'essay' ? (essays.get(item.id) || `${BASE}/university/essay?knowledge_id=${item.id}&lang=en`) : courses.get(item.id);
    const r = await fetchPage(url, item.type === 'essay' ? 'essay/page' : 'course/page');
    const tag = `[${processed}/${Math.min(LIMIT, processed + queue.length)}] ${key}`;
    if (r.dead) { report.dead.push({ key, url }); console.log(`${tag}  DEAD`); continue; }
    if (!r.ok) { report.failed.push({ key, url, reason: r.reason }); console.log(`${tag}  FAIL ${r.reason}`); continue; }

    if (item.type === 'essay') {
      const rec = parseEssay(r.data, url);
      if (!rec.text) report.empty_text.push({ key, title: rec.title });
      write(rec); report.essays_ok++;
      console.log(`${tag}  OK  ${rec.text.length.toString().padStart(6)} chars  ${rec.breadcrumb ? rec.breadcrumb + ' > ' : ''}${rec.title.slice(0, 60)}`);
      for (const id of linkedIds(r.data)) {          // safety net: anything the sitemap missed
        if (!seen.has(`essay:${id}`)) { seen.add(`essay:${id}`); queue.push({ type: 'essay', id }); report.discovered_outside_sitemap++; }
      }
    } else {
      const recs = parseCourse(r.data, item.id);
      for (const rec of recs) { if (!rec.text) report.empty_text.push({ key: `lesson:${rec.id}`, title: rec.title }); write(rec); }
      report.lessons_ok += recs.length;
      console.log(`${tag}  OK  course "${recs[0]?.course.name}" → ${recs.length} lessons`);
    }
    if (processed % 25 === 0) fs.writeFileSync(REPORT_FILE, JSON.stringify({ ...report, in_progress: true }, null, 2));
  }
  out.end();
  report.finished_at = now();
  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
  console.log(`\nDone. essays ${report.essays_ok} · course lessons ${report.lessons_ok} · dead ${report.dead.length} · failed ${report.failed.length} · empty ${report.empty_text.length} · found outside sitemap ${report.discovered_outside_sitemap}`);
  console.log(`→ ${path.relative(ROOT, OUT_FILE)}\n→ ${path.relative(ROOT, REPORT_FILE)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
