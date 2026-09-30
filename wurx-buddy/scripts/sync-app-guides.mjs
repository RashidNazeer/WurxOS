// ============================================================
// App guides: validate, check coverage, (optionally) sync to ai_assistant_docs.
// Design: architecture.md §9.9, phases.md Phase 4.
//
//   node scripts/sync-app-guides.mjs              validate + coverage report
//   node scripts/sync-app-guides.mjs --strict     … exit 1 on any gap
//   node scripts/sync-app-guides.mjs --dry-run    … and print the rows --apply would write (no DB)
//   node scripts/sync-app-guides.mjs --apply --ingestion-hold-lifted
//                                                 upsert into DEV ai_assistant_docs by slug
//                                                 (kind='app_guide'), deactivate removed guides
//
// Validation errors (bad frontmatter, unknown route/role, missing sections)
// always exit 1. Coverage also re-parses ../src/App.jsx and menu.js, so an
// inventory (_routes.json) that has drifted from the app fails too.
// --apply is behind the INGESTION HOLD (TEAM rule 8) and Owner review: it
// refuses without --ingestion-hold-lifted, and only ever connects to dev.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ASSISTANT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.resolve(ASSISTANT, '..');
const GUIDES = path.join(ASSISTANT, 'app-guides');

export const REQUIRED = ['slug', 'title', 'route', 'roles', 'feature', 'last_reviewed'];
export const SECTIONS = ['What this page is for', 'Who can use it', 'Rules & gotchas', 'Related pages'];
const NO_GUIDE_KINDS = new Set(['redirect', 'public', 'client_portal', 'oauth']);

// Minimal YAML for our frontmatter: `key: scalar`, `key: [a, b]`, null, quoted strings.
export function parseGuide(raw) {
  const text = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { error: 'no frontmatter block' };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const l = line.replace(/\s+#.*$/, '');
    if (!l.trim()) continue;
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(l);
    if (!kv) return { error: `bad frontmatter line: ${line}` };
    meta[kv[1]] = scalar(kv[2].trim());
  }
  return { meta, body: text.slice(m[0].length).trim() + '\n' };
}
function scalar(v) {
  if (v === '' || v === 'null' || v === '~') return null;
  if (v.startsWith('[') && v.endsWith(']')) return v.slice(1, -1).split(',').map((s) => scalar(s.trim())).filter((s) => s !== null);
  if (/^(['"]).*\1$/.test(v)) return v.slice(1, -1);
  return v;
}

// Routes declared in App.jsx. Nested <Route>s get their parent's path; the
// tag end is the first '>' outside {…}, so JSX inside element={…} is skipped.
export function extractAppRoutes(src) {
  const out = [];
  const stack = [];
  const re = /<Route\b|<\/Route>/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[0] === '</Route>') { stack.pop(); continue; }
    let i = m.index + m[0].length, depth = 0;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    const tag = src.slice(m.index, i + 1);
    const selfClosing = /\/\s*>$/.test(tag);
    const attrs = tag.replace(/\{[^{}]*(\{[^{}]*(\{[^{}]*\}[^{}]*)*\}[^{}]*)*\}/g, '');
    const p = /\bpath="([^"]+)"/.exec(attrs)?.[1];
    const parent = stack.at(-1) ?? '';
    const full = p == null ? null : p.startsWith('/') || p === '*' && !parent ? p : `${parent.replace(/\/$/, '')}/${p}`;
    if (full) out.push(full);
    if (!selfClosing) stack.push(full ?? parent);
    re.lastIndex = i + 1;
  }
  return out;
}

export const extractMenuPaths = (src) => [...new Set([...src.matchAll(/\bto:\s*'([^']+)'/g)].map((x) => x[1]))];

export function validateGuide(file, parsed, inv) {
  const errs = [];
  if (parsed.error) return [parsed.error];
  const { meta, body } = parsed;
  for (const k of REQUIRED) if (!(k in meta)) errs.push(`missing frontmatter field: ${k}`);
  const slug = path.basename(file, '.md');
  if (meta.slug !== slug) errs.push(`slug "${meta.slug}" must equal the filename "${slug}"`);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) errs.push('slug must be kebab-case');
  if (!meta.title) errs.push('title is empty');
  if (!meta.feature) errs.push('feature is empty');
  if (meta.last_reviewed !== null && meta.last_reviewed !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(meta.last_reviewed)) errs.push('last_reviewed must be null or YYYY-MM-DD');
  const route = inv.routes.find((r) => r.path === meta.route);
  if (!route) errs.push(`route ${meta.route} is not in _routes.json`);
  else if (route.kind !== 'page') errs.push(`route ${meta.route} is a ${route.kind} route (no staff guide)`);
  if (!Array.isArray(meta.roles) || !meta.roles.length) errs.push('roles must be a non-empty list');
  else {
    const bad = meta.roles.filter((r) => !inv.roles.includes(r));
    if (bad.length) errs.push(`unknown roles: ${bad.join(', ')}`);
    // A guide must not be retrievable by a role the page itself refuses.
    if (route?.allow) {
      const extra = meta.roles.filter((r) => !route.allow.includes(r));
      if (extra.length) errs.push(`roles not allowed on ${route.path}: ${extra.join(', ')}`);
    }
  }
  const heads = [...body.matchAll(/^##\s+(.+)$/gm)].map((x) => x[1].trim());
  for (const s of SECTIONS) if (!heads.includes(s)) errs.push(`missing section: ## ${s}`);
  if (!heads.some((h) => /^How to\b/.test(h))) errs.push('needs at least one "## How to …" section');
  return errs;
}

export function coverage(inv, guides, appRoutes, menuPaths) {
  const invPaths = new Set(inv.routes.map((r) => r.path));
  const bySlug = new Map(guides.map((g) => [g.meta.slug, g]));
  const byRoute = new Map(guides.map((g) => [g.meta.route, g]));
  const uncovered = [], danglingGuideRef = [];
  for (const r of inv.routes) {
    if (r.kind !== 'page') {
      if (!NO_GUIDE_KINDS.has(r.kind)) uncovered.push(`${r.path} (unknown kind "${r.kind}")`);
      continue;
    }
    if (byRoute.has(r.path)) continue;
    if (r.guide && bySlug.has(r.guide)) continue;
    if (r.guide) danglingGuideRef.push(`${r.path} → guide "${r.guide}" does not exist`);
    else uncovered.push(r.path);
  }
  return {
    uncovered,
    danglingGuideRef,
    orphanGuides: guides.filter((g) => !invPaths.has(g.meta.route)).map((g) => `${g.meta.slug} (${g.meta.route})`),
    notInInventory: [...new Set(appRoutes)].filter((p) => !invPaths.has(p)),
    goneFromApp: [...invPaths].filter((p) => !appRoutes.includes(p)),
    menuNotRouted: menuPaths.filter((p) => !invPaths.has(p)),
    allowList: inv.routes.filter((r) => r.kind !== 'page').map((r) => `${r.path} [${r.kind}]`),
  };
}

// `<!-- source: … -->` comments are for re-checking the guides, not for staff.
export const toRow = (g) => ({ kind: 'app_guide', slug: g.meta.slug, title: g.meta.title,
  content: g.body.replace(/[ \t]*<!--[\s\S]*?-->[ \t]*\r?\n?/g, ''), meta: g.meta, is_active: true });

function loadAll() {
  const inv = JSON.parse(fs.readFileSync(path.join(GUIDES, '_routes.json'), 'utf8'));
  // Guides are lower-case slugs; UPPERCASE.md files (REVIEW.md) are notes for us.
  const files = fs.readdirSync(GUIDES).filter((f) => f.endsWith('.md') && !/^[A-Z0-9_-]+\.md$/.test(f)).sort();
  const guides = [], errors = [];
  for (const f of files) {
    const parsed = parseGuide(fs.readFileSync(path.join(GUIDES, f), 'utf8'));
    const errs = validateGuide(f, parsed, inv);
    if (errs.length) errors.push(...errs.map((e) => `${f}: ${e}`));
    else guides.push({ file: f, ...parsed });
  }
  for (const [k, list] of [['slug', guides.map((g) => g.meta.slug)], ['route', guides.map((g) => g.meta.route)]]) {
    const dup = list.filter((v, i) => list.indexOf(v) !== i);
    if (dup.length) errors.push(`duplicate ${k}: ${[...new Set(dup)].join(', ')}`);
  }
  return { inv, files, guides, errors };
}

async function apply(guides) {
  const { default: pg } = await import('pg');
  const { devDbUrl, SSL } = await import('./dev-env.mjs');
  const client = new pg.Client({ connectionString: devDbUrl(), ssl: SSL });
  await client.connect();
  try {
    await client.query('begin');
    for (const r of guides.map(toRow)) {
      // Never take over a slug that belongs to a curated doc.
      const res = await client.query(
        `insert into public.ai_assistant_docs (kind, slug, title, content, meta, is_active)
         values ('app_guide', $1, $2, $3, $4, true)
         on conflict (slug) where slug is not null do update
           set title = excluded.title, content = excluded.content, meta = excluded.meta,
               is_active = true, updated_at = now()
           where ai_assistant_docs.kind = 'app_guide'
             and (ai_assistant_docs.title, ai_assistant_docs.content, ai_assistant_docs.meta, ai_assistant_docs.is_active)
                 is distinct from (excluded.title, excluded.content, excluded.meta, true)
         returning (xmax = 0) as inserted`, [r.slug, r.title, r.content, r.meta]);
      const { rows: [own] } = await client.query(`select kind from public.ai_assistant_docs where slug = $1`, [r.slug]);
      if (own.kind !== 'app_guide') throw new Error(`slug ${r.slug} belongs to a kind='${own.kind}' row`);
      console.log(`${res.rowCount ? (res.rows[0].inserted ? '+ insert' : '~ update') : '= same  '} ${r.slug}`);
    }
    const { rows } = await client.query(
      `update public.ai_assistant_docs set is_active = false, updated_at = now()
        where kind = 'app_guide' and is_active and not (slug = any($1)) returning slug`, [guides.map((g) => g.meta.slug)]);
    for (const r of rows) console.log(`- deactivate ${r.slug}`);
    await client.query('commit');
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    await client.end();
  }
}

async function main(argv) {
  const flags = new Set(argv);
  const known = ['--strict', '--dry-run', '--apply', '--ingestion-hold-lifted'];
  const unknown = [...flags].filter((f) => !known.includes(f));
  if (unknown.length) { console.error(`unknown option(s): ${unknown.join(' ')}`); return 2; }
  if (flags.has('--apply') && flags.has('--dry-run')) { console.error('--apply and --dry-run are exclusive'); return 2; }

  const { inv, files, guides, errors } = loadAll();
  const appRoutes = extractAppRoutes(fs.readFileSync(path.join(APP, 'src', 'App.jsx'), 'utf8'));
  const menuPaths = extractMenuPaths(fs.readFileSync(path.join(APP, 'src', 'components', 'layout', 'menu.js'), 'utf8'));
  const cov = coverage(inv, guides, appRoutes, menuPaths);
  const pages = inv.routes.filter((r) => r.kind === 'page');

  console.log(`App guides: ${files.length} file(s), ${guides.length} valid, ${errors.length} error(s)`);
  for (const e of errors) console.log(`  ✗ ${e}`);
  console.log(`\nCoverage: ${pages.length - cov.uncovered.length - cov.danglingGuideRef.length}/${pages.length} staff page routes covered; ${cov.allowList.length} allow-listed (no staff guide)`);
  const sections = [
    ['Routes without a guide', cov.uncovered],
    ['Routes pointing at a missing guide', cov.danglingGuideRef],
    ['Guides whose route does not exist', cov.orphanGuides],
    ['App.jsx routes missing from _routes.json (inventory stale)', cov.notInInventory],
    ['_routes.json routes gone from App.jsx (inventory stale)', cov.goneFromApp],
    ['Menu links with no route', cov.menuNotRouted],
  ];
  for (const [label, list] of sections) console.log(`  ${list.length ? '✗' : '✓'} ${label}: ${list.length ? `\n      ${list.join('\n      ')}` : 'none'}`);
  console.log(`  · Allow-list: ${cov.allowList.join(', ')}`);

  if (flags.has('--dry-run')) {
    console.log(`\nDry run — rows --apply would upsert into public.ai_assistant_docs (by slug):`);
    for (const r of guides.map(toRow)) {
      const words = r.content.split(/\s+/).filter(Boolean).length;
      console.log(`  ${JSON.stringify({ kind: r.kind, slug: r.slug, title: r.title, is_active: r.is_active, meta: r.meta, content: `<${r.content.length} chars, ${words} words>` })}`);
    }
    console.log(`  + deactivate every active kind='app_guide' row whose slug is not one of these ${guides.length}.`);
  }

  const gaps = sections.reduce((n, [, l]) => n + l.length, 0);
  if (errors.length) return 1;
  if (flags.has('--strict') && gaps) return 1;

  if (flags.has('--apply')) {
    if (!flags.has('--ingestion-hold-lifted')) {
      console.error('\nRefusing --apply: the INGESTION HOLD (TEAM.md rule 8) and Owner review of the guides come first. Re-run with --ingestion-hold-lifted once both are cleared.');
      return 1;
    }
    if (gaps) { console.error('\nRefusing --apply with coverage gaps; fix them (or run the report with --strict) first.'); return 1; }
    await apply(guides);
  }
  return 0;
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
