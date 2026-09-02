// ============================================================
// Seed the demo database — Meridian Media.
//
//   node scripts/seed-demo.mjs            # seed (skips what already exists)
//   node scripts/seed-demo.mjs --reset    # wipe demo data first, then seed
//
// Reads DEMO_SUPABASE_URL + DEMO_SERVICE_KEY from the environment or from
// .env.demo.local. It will REFUSE to run against the production project.
//
// WHAT THIS BUILDS
// ----------------
// A whole small agency with about three months of history, so every screen in
// the app has something real-looking on it: 15 people across all eight roles,
// 8 brands, daily attendance, tasks, weekly client reports with star ratings,
// three months of incentive plans covering all four payout sources,
// performance scores, flags, leave, agenda meetings and checkpoints.
//
// Everything is invented. No name, brand, figure or note here comes from the
// real database — that is the entire point of the exercise.
//
// DESIGN NOTES
// ------------
// * Dates are RELATIVE to the day you run it, so the demo never looks stale.
//   Run it again in three months and it is current again.
// * The random numbers come from a seeded PRNG, so two runs produce the same
//   company. A demo that reshuffles itself between rehearsal and performance
//   is worse than useless.
// * It writes with the service key, which bypasses RLS but NOT triggers — so
//   notifications, audit rows and cascades all fire exactly as they would in
//   real use. That is deliberate: it is the same code path, so the demo cannot
//   drift away from how the product actually behaves.
// ============================================================

import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEMO_USERS, DEMO_BRANDS, DEMO_ADS_BRANDS,
  DEMO_PAID_COLLAB_BRANDS, DEMO_OL_INCENTIVE_BRANDS,
} from '../src/lib/demoRoster.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESET = process.argv.includes('--reset');

// ── Config ──────────────────────────────────────────────────────────────────
function readEnvFile(file) {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) return {};
  return Object.fromEntries(
    fs.readFileSync(p, 'utf8').split('\n')
      .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
  );
}
const fileEnv = { ...readEnvFile('.env.demo'), ...readEnvFile('.env.demo.local') };
const cfg = (k) => process.env[k] || fileEnv[k] || '';

const URL = cfg('DEMO_SUPABASE_URL') || cfg('VITE_SUPABASE_URL');
const KEY = cfg('DEMO_SERVICE_KEY');
const PASSWORD = cfg('VITE_DEMO_PASSWORD') || 'OpsDeckDemo!2026';

// The one check that matters. Everything below writes with a service key and
// deletes with --reset; pointed at the wrong project it would be a disaster,
// so this is a hard stop rather than a warning.
const PRODUCTION_REF = 'xoaaidgvblondjpvxjqp';
if (!URL || !KEY) {
  console.error('Missing DEMO_SUPABASE_URL / DEMO_SERVICE_KEY (env or .env.demo.local).');
  process.exit(1);
}
if (URL.includes(PRODUCTION_REF)) {
  console.error('REFUSING TO RUN: that URL is the PRODUCTION project.');
  process.exit(1);
}

const db = createClient(URL, KEY, { auth: { persistSession: false } });
console.log(`Seeding ${URL}${RESET ? '  (reset first)' : ''}\n`);

// ── Small helpers ───────────────────────────────────────────────────────────

// Deterministic PRNG (mulberry32) so the demo is identical on every run.
let _s = 0x9e3779b9;
const rnd = () => {
  _s |= 0; _s = (_s + 0x6d2b79f5) | 0;
  let t = Math.imul(_s ^ (_s >>> 15), 1 | _s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const money = (lo, hi) => Math.round((lo + rnd() * (hi - lo)) * 100) / 100;
const chance = (p) => rnd() < p;

const TODAY = new Date();
const iso = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${da}`;
};
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const isWeekend = (d) => d.getDay() === 0 || d.getDay() === 6;
// The database is pinned to Asia/Karachi, so timestamps are written with that
// offset rather than UTC — otherwise a 9am clock-in lands as 2pm on screen.
const pkt = (d, h, m = 0) =>
  `${iso(d)}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+05:00`;

// Insert in batches; PostgREST gets unhappy with very large single payloads.
async function insert(table, rows, { chunk = 400, onConflict } = {}) {
  if (!rows.length) return 0;
  let done = 0;
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const q = onConflict
      ? db.from(table).upsert(slice, { onConflict, ignoreDuplicates: false })
      : db.from(table).insert(slice);
    const { error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    done += slice.length;
  }
  return done;
}
const log = (label, n) => console.log(`  ${String(n).padStart(5)}  ${label}`);

// ── 0. Reset ────────────────────────────────────────────────────────────────
// Uses the app's own wipe RPC where possible so the demo is torn down exactly
// the way the product tears itself down, then removes the auth users the RPC
// deliberately leaves behind (it preserves the caller; there is no caller here).
async function reset() {
  console.log('Reset — clearing existing demo data');

  // wipe_all_operational_data is Boss-gated on auth.uid(), and a service-role
  // client has no auth.uid() at all — so calling it with the admin key silently
  // does nothing. Sign in as the demo Boss instead and let the product tear
  // itself down through its own supported path.
  const ANON = cfg('VITE_SUPABASE_ANON_KEY');
  if (ANON) {
    const asBoss = createClient(URL, ANON, { auth: { persistSession: false } });
    const boss = DEMO_USERS.find((u) => u.role === 'boss');
    const { error: signInErr } = await asBoss.auth.signInWithPassword({
      email: boss.email, password: PASSWORD,
    });
    if (signInErr) {
      console.log('  (no Boss account yet — nothing to wipe)');
    } else {
      const { error } = await asBoss.rpc('wipe_all_operational_data');
      console.log(error ? `  (wipe RPC: ${error.message})` : '  operational data wiped');
      await asBoss.auth.signOut();
    }
  }

  let page = 1;
  for (;;) {
    const { data, error: e } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (e) throw new Error(e.message);
    const users = data?.users || [];
    if (!users.length) break;
    for (const u of users) await db.auth.admin.deleteUser(u.id);
    if (users.length < 200) break;
    page += 1;
  }
  console.log('  cleared\n');
}

// ── 1. People ───────────────────────────────────────────────────────────────
// The profile row is created by the handle_new_user trigger from user_metadata
// (mig 001/003), so the account is made first and the profile patched after —
// same order the create-user edge function uses.
const idOf = {};   // roster key -> uuid

async function seedPeople() {
  console.log('People');
  const { data: existing } = await db.auth.admin.listUsers({ page: 1, perPage: 200 });
  const byEmail = new Map((existing?.users || []).map((u) => [u.email.toLowerCase(), u.id]));

  let made = 0;
  for (const u of DEMO_USERS) {
    const found = byEmail.get(u.email.toLowerCase());
    if (found) { idOf[u.key] = found; continue; }
    const { data, error } = await db.auth.admin.createUser({
      email: u.email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { display_name: u.name, role: u.role, responsibilities: [] },
    });
    if (error) throw new Error(`createUser ${u.email}: ${error.message}`);
    idOf[u.key] = data.user.id;
    made += 1;
  }
  log('accounts created', made);

  // Patch the profiles: role and reporting line, plus the fields the trigger
  // does not set. reports_to is resolved here because it needs the other
  // accounts to exist first.
  for (const u of DEMO_USERS) {
    const patch = {
      display_name: u.name,
      role: u.role,
      is_active: true,
      start_date: u.startDate,
      reports_to: u.reportsTo ? idOf[u.reportsTo] : null,
      timezone: 'Asia/Karachi',
      // A shift start is what arms the clock-in reminder; giving everyone one
      // means the feature is demonstrable instead of dormant.
      shift_start_time: u.role === 'boss' ? null : '09:00',
      responsibilities: [u.title],
    };
    const { error } = await db.from('profiles').update(patch).eq('id', idOf[u.key]);
    if (error) throw new Error(`profile ${u.email}: ${error.message}`);
  }
  log('profiles configured', DEMO_USERS.length);

  // Compensation. The Boss has no salary anywhere in this app, so they are
  // excluded rather than given a zero — a zero would show up as a real figure.
  const comp = DEMO_USERS.filter((u) => u.role !== 'boss').map((u) => ({
    user_id: idOf[u.key],
    basic_salary: u.salary,
    effective_from: u.startDate,
    last_change_reason: 'Initial salary',
  }));
  await insert('employee_compensation', comp, { onConflict: 'user_id' });
  log('compensation rows', comp.length);

  // A couple of raises so the salary history screen is not empty.
  const raised = ['apc_leo', 'apc_mira', 'tl_alpha'];
  const hist = raised.map((k) => {
    const u = DEMO_USERS.find((x) => x.key === k);
    const prev = Math.round(u.salary * 0.88);
    return {
      user_id: idOf[k],
      previous_amount: prev,
      new_amount: u.salary,
      increment_pct: Math.round(((u.salary - prev) / prev) * 1000) / 10,
      change_reason: 'annual_increment',
      boss_notes: 'Annual review — consistently strong performance.',
      effective_from: iso(addDays(TODAY, -120)),
      changed_by: idOf.boss,
    };
  });
  await insert('salary_history', hist);
  log('salary history', hist.length);
}

// ── 2. Brands ───────────────────────────────────────────────────────────────
const brandId = {};

async function seedBrands() {
  console.log('\nBrands');
  const rows = DEMO_BRANDS.map((b) => ({
    brand_name: b.name,
    client_name: b.client,
    currency: b.currency,
    tier: b.tier,
    owner_id: idOf[b.owner],          // the TL owns the brand, never the APC
    status: 'active',
    gmv_max_status: 'managed_internally',
    paid_collab_status: DEMO_PAID_COLLAB_BRANDS.includes(b.key) ? 'managed_internally' : 'managed_by_brand',
    last_sale_generated_date: iso(addDays(TODAY, -int(3, 26))),
    created_by: idOf.boss,
  }));
  const { data, error } = await db.from('brands').insert(rows).select('id, brand_name');
  if (error) throw new Error(`brands: ${error.message}`);
  for (const b of DEMO_BRANDS) {
    brandId[b.key] = data.find((r) => r.brand_name === b.name).id;
  }
  log('brands', data.length);

  // brand_assignments is the APC <-> brand link. A null expires_at is a
  // permanent assignment; a dated one is temporary cover, and the app treats
  // the two very differently (cover does not own the brand's numbers), so the
  // demo carries one of each to make that visible.
  const assign = [];
  for (const b of DEMO_BRANDS) {
    for (const k of b.apcs) {
      assign.push({ brand_id: brandId[b.key], user_id: idOf[k], assigned_by: idOf.boss });
    }
    if (b.cover) {
      assign.push({
        brand_id: brandId[b.key],
        user_id: idOf[b.cover.apc],
        assigned_by: idOf.ol,
        expires_at: new Date(addDays(TODAY, b.cover.days)).toISOString(),
      });
    }
  }
  await insert('brand_assignments', assign);
  log('assignments (1 temporary)', assign.length);

  await insert('ads_manager_brands', DEMO_ADS_BRANDS.map((k) => ({
    ads_manager_id: idOf.ads, brand_id: brandId[k], assigned_by: idOf.ol,
  })));
  log('ads manager brands', DEMO_ADS_BRANDS.length);

  await insert('ol_incentive_brands', DEMO_OL_INCENTIVE_BRANDS.map((k) => ({
    ol_id: idOf.ol, brand_id: brandId[k],
  })));
  log('OL incentive brands', DEMO_OL_INCENTIVE_BRANDS.length);

  await insert('paid_collab_brands', DEMO_PAID_COLLAB_BRANDS.map((k) => ({
    brand_id: brandId[k], added_by: idOf.pctl,
  })));
  log('paid collab brands', DEMO_PAID_COLLAB_BRANDS.length);

  // Monthly goals for the last three months. The current month is deliberately
  // mid-flight — some brands ahead, some behind — because a board where
  // everything is green teaches the viewer nothing.
  const metrics = [];
  for (let back = 2; back >= 0; back--) {
    const d = new Date(TODAY.getFullYear(), TODAY.getMonth() - back, 1);
    const mk = monthKey(d);
    const partial = back === 0 ? 0.55 + rnd() * 0.4 : 1;
    for (const b of DEMO_BRANDS) {
      const drift = 0.86 + rnd() * 0.3;
      metrics.push({
        brand_id: brandId[b.key],
        month_key: mk,
        gmv_target: Math.round(b.gmvTarget * (back === 0 ? 1 : 0.92 + rnd() * 0.16)),
        gmv_achieved: Math.round(b.gmvAchieved * drift * partial),
        roi_target: 3.5,
        roi_achieved: Math.round((2.8 + rnd() * 2.2) * 100) / 100,
        samples_target: int(40, 120),
        samples_achieved: int(25, 130),
        gmv_max_allocated: int(4, 14) * 1000,
        gmv_max_used: int(2, 13) * 1000,
        paid_collab_allocated: int(2, 8) * 1000,
        paid_collab_used: int(1, 7) * 1000,
        updated_by: idOf.ol,
      });
    }
  }
  await insert('brand_monthly_metrics', metrics, { onConflict: 'brand_id,month_key' });
  log('monthly brand goals', metrics.length);

  // FX rates — a Commission Based Tier line is computed in the brand's own
  // currency and paid in PKR, and without a rate for the month it refuses to
  // convert and shows as unpayable. Both currencies in use are covered.
  const fx = [];
  for (let back = 2; back >= 0; back--) {
    const mk = monthKey(new Date(TODAY.getFullYear(), TODAY.getMonth() - back, 1));
    fx.push({ currency: 'USD', month_key: mk, rate: 278.5, updated_by: idOf.boss });
    fx.push({ currency: 'GBP', month_key: mk, rate: 353.2, updated_by: idOf.boss });
  }
  await insert('payout_fx_rates', fx, { onConflict: 'currency,month_key' });
  log('payout FX rates', fx.length);
}

// ── 3. Attendance ───────────────────────────────────────────────────────────
// ~11 weeks of weekdays for everyone but the Boss. This is what makes the
// dashboards, the attendance score and the attendance-linked incentive line
// all show real numbers instead of zeros.
async function seedAttendance() {
  console.log('\nAttendance');
  const staff = DEMO_USERS.filter((u) => u.role !== 'boss');
  const rows = [];
  for (let back = 76; back >= 1; back--) {
    const day = addDays(TODAY, -back);
    if (isWeekend(day)) continue;
    for (const u of staff) {
      if (new Date(u.startDate) > day) continue;
      // A small amount of absence, so the attendance percentage is a real
      // number people can ask questions about rather than a flat 100%.
      if (chance(0.045)) continue;
      const late = chance(0.18);
      const inH = 9, inM = late ? int(12, 48) : int(0, 8);
      const workMin = int(485, 545);
      const breakMin = int(30, 62);
      const out = new Date(day);
      out.setHours(inH, inM + workMin + breakMin);
      rows.push({
        user_id: idOf[u.key],
        date: iso(day),
        clock_in: pkt(day, inH, inM),
        clock_out: pkt(day, out.getHours(), out.getMinutes()),
        status: 'clocked-out',
        location: chance(0.22) ? 'wfh' : pick(['bahria', 'lakecity', 'office']),
        total_work_ms: workMin * 60000,
        total_break_ms: breakMin * 60000,
        breaks: [],
      });
    }
  }
  await insert('attendance', rows, { onConflict: 'user_id,date' });
  log('attendance days', rows.length);

  // A handful of people are on the clock right now, so the live "who is
  // working" view has something in it during the walkthrough.
  if (!isWeekend(TODAY)) {
    const open = ['apc_leo', 'apc_mira', 'apc_ayesha', 'tl_alpha', 'ol', 'ipc_ruth'].map((k) => ({
      user_id: idOf[k],
      date: iso(TODAY),
      clock_in: pkt(TODAY, 9, int(2, 40)),
      status: 'clocked-in',
      location: pick(['bahria', 'lakecity', 'office']),
      breaks: [],
    }));
    await insert('attendance', open, { onConflict: 'user_id,date' });
    log('currently clocked in', open.length);
  }

  // Public holidays, so the attendance maths visibly excludes them.
  await insert('company_holidays', [
    { label: 'Independence Day', start_date: `${TODAY.getFullYear()}-08-14`, end_date: `${TODAY.getFullYear()}-08-14`, created_by: idOf.boss },
    { label: 'Quaid-e-Azam Day', start_date: `${TODAY.getFullYear()}-12-25`, end_date: `${TODAY.getFullYear()}-12-25`, created_by: idOf.boss },
  ]);
  log('company holidays', 2);
}

// ── 4. Leave ────────────────────────────────────────────────────────────────
async function seedLeave() {
  console.log('\nLeave');
  // Leave types are the org's own set (mig 001): wfh / medical / emergency /
  // half_leave / other. 'other' carries a free-text other_title.
  const rows = [
    { k: 'apc_nadia', type: 'other', title: 'Annual leave', from: -2, to: 6, status: 'approved',
      reason: 'Family wedding — cover arranged with Ivan for Bloom Botanicals.' },
    { k: 'apc_jonah', type: 'medical', from: -18, to: -17, status: 'approved', reason: 'Flu — doctor advised two days off.' },
    { k: 'ipc_kai', type: 'other', title: 'Annual leave', from: 12, to: 16, status: 'pending',
      reason: 'Short break between campaign cycles.' },
    { k: 'apc_ivan', type: 'half_leave', from: -34, to: -34, status: 'approved', reason: 'Personal errand, back by 2pm.' },
    { k: 'apc_ayesha', type: 'wfh', from: 3, to: 4, status: 'pending', reason: 'Internet engineer visiting.' },
    { k: 'tl_beta', type: 'emergency', from: -9, to: -9, status: 'rejected',
      reason: 'Clashed with the monthly client review.' },
    { k: 'apc_leo', type: 'wfh', from: -25, to: -25, status: 'approved', reason: 'Working from home for the launch call.' },
  ].map((r) => ({
    requester_id: idOf[r.k],
    type: r.type,
    ...(r.title ? { other_title: r.title } : {}),
    start_date: iso(addDays(TODAY, r.from)),
    end_date: iso(addDays(TODAY, r.to)),
    reason: r.reason,
    status: r.status,
    ...(r.status === 'pending' ? {} : { decided_by: idOf.ol, decided_at: new Date(addDays(TODAY, r.from - 2)).toISOString() }),
  }));
  await insert('leave_requests', rows);
  log('leave requests', rows.length);
}

// ── 5. Tasks ────────────────────────────────────────────────────────────────
const TASK_TITLES = [
  'Refresh the creator outreach list for this month',
  'Chase the sample shipment for the new SKU',
  'Rework the product description for the hero listing',
  'Book three livestream slots for next week',
  'Review last week\'s video performance and flag the outliers',
  'Prepare the creator brief for the autumn campaign',
  'Follow up with the top 5 creators who went quiet',
  'Update the affiliate commission tiers in the shop',
  'Audit the sample approval backlog',
  'Draft the client update email',
  'Reconcile GMV Max spend against the allocation',
  'Collect UGC assets for the paid collab set',
  'Check the return rate on the bundle listing',
  'Set up the promo codes for the flash sale',
  'Write the creator payout summary',
];

async function seedTasks() {
  console.log('\nTasks');
  const rows = [];
  const apcs = DEMO_USERS.filter((u) => u.role === 'apc' || u.role === 'ipc');
  for (const u of apcs) {
    const brands = DEMO_BRANDS.filter((b) => b.apcs.includes(u.key));
    for (let i = 0; i < int(4, 7); i++) {
      const st = pick(['todo', 'todo', 'in_progress', 'done', 'done']);
      const due = addDays(TODAY, int(-12, 14));
      rows.push({
        title: pick(TASK_TITLES),
        description: 'Raised in the weekly meeting.',
        assignee_id: idOf[u.key],
        created_by: idOf[u.reportsTo] || idOf.ol,
        brand_id: brands.length ? brandId[pick(brands).key] : null,
        status: st,
        priority: pick(['low', 'medium', 'medium', 'high']),
        category: pick(['general', 'daily', 'weekly', 'monthly']),
        due_date: iso(due),
      });
    }
  }
  const { data, error } = await db.from('tasks').insert(rows).select('id');
  if (error) throw new Error(`tasks: ${error.message}`);
  log('tasks', data.length);

  const comments = data.slice(0, 14).map((t, i) => ({
    task_id: t.id,
    author_id: i % 2 ? idOf.tl_alpha : idOf.ol,
    body: pick([
      'Can you get this done before the client call on Thursday?',
      'Done — numbers are in the sheet.',
      'Blocked on the sample shipment, chasing the supplier.',
      'Nice work on this one.',
    ]),
  }));
  await insert('task_comments', comments);
  log('task comments', comments.length);
}

// ── 6. Weekly reports ───────────────────────────────────────────────────────
// The core deliverable of the business, so this gets the most care. Eight weeks
// per brand, mostly approved, with the most recent ones spread across the
// workflow — draft, submitted, verified — so the review chain is visible.
const CREATOR_NAMES = [
  '@sunnysidefinds', '@thedailyedit', '@martarosecooks', '@fitwithdev', '@homebodyhaul',
  '@glowbyjuno', '@petsofpine', '@kitchenkiera', '@oliverunfast', '@thesupplementguy',
  '@wellnesswithmo', '@budgetbeautyco', '@dailydoseofdana', '@trailmixtom',
];
const PRODUCTS = {
  novafuel: ['Whey Isolate 2lb', 'Creatine Micronised', 'Pre-Workout Berry', 'Greens Blend'],
  lumen: ['Vitamin C Serum', 'Ceramide Cream', 'Gentle Cleanser', 'SPF 50 Fluid'],
  terrapaws: ['Grain-Free Salmon 5kg', 'Dental Chews', 'Joint Support Soft Chews'],
  brightside: ['Magnesium Complex', 'Sleep Gummies', 'Daily Multivitamin'],
  kettle: ['Sea Salt Chips 6pk', 'Truffle Popcorn', 'Sourdough Crackers'],
  verahome: ['Linen Duvet Set', 'Ceramic Mug Set', 'Woven Throw'],
  peak: ['Compression Leggings', 'Training Tee', 'Lightweight Windbreaker'],
  bloom: ['Ashwagandha Capsules', 'Elderberry Syrup', 'Turmeric Latte Mix'],
};

function weeklyData(b, weekIdx) {
  const scale = 0.7 + rnd() * 0.6;
  const gmv = Math.round(b.gmvAchieved / 4.3 * scale);
  const cur = b.currency;
  const creators = Array.from({ length: 5 }, () => ({
    name: pick(CREATOR_NAMES),
    videosPosted: String(int(1, 9)),
    itemsSold: String(int(12, 380)),
    gmv: String(money(180, 6400)),
    notes: '',
  }));
  const videos = Array.from({ length: 4 }, () => ({
    creatorName: pick(CREATOR_NAMES),
    videoLink: 'https://www.tiktok.com/@demo/video/0000000000000000000',
    itemsSold: String(int(5, 210)),
    gmv: String(money(90, 3900)),
    views: String(int(4000, 480000)),
    productClicks: String(int(120, 9800)),
    notes: '',
  }));
  const prods = (PRODUCTS[b.key] || []).slice(0, 3).map((name) => ({
    productId: '', productName: name,
    unitsSold: String(int(30, 700)),
    gmv: String(money(400, 9000)),
    newVideos: String(int(2, 24)),
    samplesApprovedWeek: String(int(2, 18)),
    samplesApprovedMtd: String(int(10, 70)),
    videosMtd: String(int(10, 90)),
    notes: '',
  }));
  return {
    currency: cur,
    overallPerformance: {
      gmv: String(gmv),
      affiliateGmv: String(Math.round(gmv * (0.55 + rnd() * 0.3))),
      orders: String(int(180, 2400)),
      samplesApproved: String(int(8, 40)),
      roi: String(Math.round((2.4 + rnd() * 2.6) * 100) / 100),
      shopPerformanceScore: String(Math.round((3.8 + rnd() * 1.1) * 10) / 10),
      videosPosted: String(int(30, 190)),
    },
    overallNotes: {
      samplesApproved: String(int(40, 140)),
      videosPosted: String(int(600, 3200)),
      gmv: String(Math.round(gmv * (2 + rnd() * 2))),
      videosMtd: String(int(120, 700)),
    },
    overallInsights: '',
    topCreators: creators,
    topCreatorsInsights: '',
    topVideos: videos,
    topVideosInsights: '',
    gmvMax: [{
      campaign: `${b.name} — Always On`,
      spend: String(money(700, 4200)),
      roi: String(Math.round((2.1 + rnd() * 2.4) * 100) / 100),
      orders: String(int(60, 900)),
      cpo: String(money(3, 14)),
      gmv: String(money(2500, 22000)),
      notes: '',
    }],
    gmvMaxMtd: [{
      campaign: `${b.name} — Always On`,
      spend: String(money(3200, 15000)),
      roi: String(Math.round((2.2 + rnd() * 2.1) * 100) / 100),
      orders: String(int(320, 3600)),
      cpo: String(money(3, 13)),
      gmv: String(money(12000, 90000)),
      notes: '',
    }],
    gmvMaxInsights: '',
    productHighlights: prods,
    productHighlightsInsights: '',
    offsitePerformance: { offsiteGmv: '', tiktokShopGmv: '', offsiteEffect: '', dataFrom: '', dataTo: '' },
    offsiteInsights: '',
    upcomingCampaigns: pick([
      'Flash sale planned for the last week of the month, creators briefed.',
      'Bundle launch going live Monday — 12 creators confirmed for launch-day content.',
      'Seasonal campaign in build; sampling list finalised, shipping this week.',
    ]),
    operationalUpdates: pick([
      'Sample approvals cleared the backlog this week. Two listings had stock warnings.',
      'Shipping delays on one SKU pushed three collabs to next week.',
      'Nothing blocking. Listing images refreshed on the two hero products.',
    ]),
    recommendations: pick([
      'Increase GMV Max allocation on the hero SKU — ROI has held above 3 for three weeks.',
      'Shift sampling budget toward mid-tier creators; conversion is better than the top tier.',
      'Re-shoot the product video for the underperforming listing before the next push.',
    ]),
    actionItems: '',
    reportInsights: pick([
      'Strong week driven by two creator videos that outperformed everything else. Worth doubling down on that format.',
      'Flat against last week. The dip is entirely one SKU going out of stock mid-week.',
      'Best week of the month so far — the bundle is doing the work and the ad spend is efficient.',
    ]),
    insightsSingle: true,
    customFields: {},
  };
}

const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
// Weeks are calendar blocks within a month (1-7, 8-14, 15-21, 22-28, 29-end),
// matching getWeeksForMonth's no-anchor branch in reportsApi.
function weeksBack(count) {
  const out = [];
  for (let back = 0; back < count; back++) {
    const ref = addDays(TODAY, -7 * back);
    const dom = ref.getDate();
    const wk = Math.min(Math.floor((dom - 1) / 7) + 1, 5);
    const start = new Date(ref.getFullYear(), ref.getMonth(), 1 + (wk - 1) * 7);
    const lastOfMonth = new Date(ref.getFullYear(), ref.getMonth() + 1, 0);
    const end = addDays(start, 6) > lastOfMonth ? lastOfMonth : addDays(start, 6);
    const label = `Week ${wk} (${MONTH_SHORT[start.getMonth()]} ${start.getDate()} - ${
      start.getMonth() === end.getMonth() ? end.getDate() : `${MONTH_SHORT[end.getMonth()]} ${end.getDate()}`})`;
    out.push({
      week: wk, year: start.getFullYear(), month: start.getMonth(),
      startDate: iso(start), endDate: iso(end), label,
    });
  }
  return out;
}

async function seedReports() {
  console.log('\nWeekly reports');
  const periods = weeksBack(9).reverse();   // oldest first
  const rows = [];
  for (const b of DEMO_BRANDS) {
    const apcKey = b.apcs[0];
    periods.forEach((p, i) => {
      const age = periods.length - 1 - i;    // 0 = most recent
      // The newest weeks sit mid-workflow on purpose; older ones are settled.
      const status = age === 0 ? pick(['draft', 'submitted'])
        : age === 1 ? pick(['submitted', 'verified'])
          : 'approved';
      const settled = status === 'approved' || status === 'verified';
      const at = (d) => new Date(addDays(new Date(p.endDate), d)).toISOString();
      rows.push({
        brand_id: brandId[b.key],
        author_id: idOf[apcKey],
        type: 'weekly',
        period_start: p.startDate,
        period_end: p.endDate,
        period_number: p.week,
        period_year: p.year,
        period_month: p.month,
        period_label: p.label,
        status,
        data: weeklyData(b, i),
        ...(status !== 'draft' ? { submitted_at: at(1), submitted_by: idOf[apcKey] } : {}),
        ...(settled ? { verified_at: at(2), verified_by: idOf[b.owner] } : {}),
        ...(status === 'approved' ? { approved_at: at(3), approved_by: idOf.ol } : {}),
        // Star ratings drive the reporting half of the performance score, so
        // settled reports carry them. Deliberately not all 5s.
        ...(settled ? {
          apc_stars: pick([3.5, 4, 4, 4.5, 4.5, 5]),
          apc_stars_by: idOf.ol,
          tl_stars: pick([4, 4, 4.5, 4.5, 5]),
          tl_stars_by: idOf.ol,
        } : {}),
        shared_with_client: status === 'approved' && chance(0.6),
      });
    });
  }
  await insert('reports', rows, { chunk: 40 });
  log('weekly reports', rows.length);
}

// ── 7. Performance ──────────────────────────────────────────────────────────
const METRIC_KEYS = ['dailyTasksQuality', 'reporting', 'overallWorkflow', 'responseTime', 'tasksProcessing'];

async function seedPerformance() {
  console.log('\nPerformance');
  await db.from('performance_config').upsert({
    id: 1,
    weight_performance: 40, weight_incentives: 20, weight_attendance: 25, weight_flags: 15,
    threshold_promotion: 85, threshold_good: 70, threshold_warning: 55,
    updated_by: idOf.boss,
  }, { onConflict: 'id' });
  log('performance config', 1);

  const rated = DEMO_USERS.filter((u) => ['tl', 'pctl', 'apc', 'ipc', 'ol'].includes(u.role));
  const rows = [];
  for (let back = 2; back >= 1; back--) {   // two closed months; current is live
    const mk = monthKey(new Date(TODAY.getFullYear(), TODAY.getMonth() - back, 1));
    for (const u of rated) {
      // Give each person a stable character rather than pure noise — a demo is
      // more persuasive when Mira is consistently strong and Jonah consistently
      // struggles, because that is what the screens are for.
      const base = u.key === STAR ? 0.94 : u.key === STRUGGLING ? 0.58 : 0.74 + rnd() * 0.16;
      // Metrics are stored 0-100: the generated overall_score column is a
      // plain average of these five, with no rescaling.
      const metrics = Object.fromEntries(
        METRIC_KEYS.map((k) => [k, Math.round(Math.min(1, Math.max(0.35, base + (rnd() - 0.5) * 0.14)) * 100)]),
      );
      // overall_score is a GENERATED column — Postgres derives it from
      // metrics with the same expression production uses, so the demo's scores
      // are computed by the product, not made up here.
      rows.push({
        user_id: idOf[u.key], month: mk, metrics,
        evaluated_by: idOf.ol, source: 'manual',
      });
    }
  }
  await insert('performance_ratings', rows, { onConflict: 'user_id,month' });
  log('monthly ratings', rows.length);

  const flags = [
    { k: 'apc_jonah', type: 'red', severity: 'high', reason: 'Weekly report submitted two days late for the second week running.', d: -38 },
    { k: 'apc_jonah', type: 'red', severity: 'medium', reason: 'Missed the Tuesday agenda meeting without notice.', d: -9 },
    { k: 'apc_mira', type: 'green', severity: 'low', reason: 'Recovered a lapsed top creator and beat the brand target by 9%.', d: -40 },
    { k: 'apc_mira', type: 'green', severity: 'low', reason: 'Covered two brands for a week without dropping either.', d: -11 },
    { k: 'apc_leo', type: 'green', severity: 'low', reason: 'Cleared the entire sample backlog ahead of the launch.', d: -36 },
    { k: 'apc_ivan', type: 'red', severity: 'low', reason: 'Clock-in missed on two consecutive days.', d: -6 },
    { k: 'ipc_ruth', type: 'green', severity: 'low', reason: 'Negotiated a paid collab 20% under budget.', d: -42 },
  ].map((f) => ({
    user_id: idOf[f.k], type: f.type, severity: f.severity, reason: f.reason,
    created_by: idOf.ol, created_at: new Date(addDays(TODAY, f.d)).toISOString(),
  }));
  await insert('performance_flags', flags);
  log('performance flags', flags.length);
}

// ── 8. Incentives ───────────────────────────────────────────────────────────
// Three months per person, and deliberately exercising all four "derived"
// sources the app supports — attendance, OL brands, GMV Max and Commission
// Based Tier — because those are the parts that are hard to explain in words
// and obvious the moment you see them on screen.
const STAR = 'apc_mira';      // promotion band
const STRUGGLING = 'apc_jonah'; // warning band

function incentiveItems(u, mk, closed) {
  const items = [];
  // A month the star closed is a month they cleared everything.
  const allDone = closed && u.key === STAR;
  const id = () => `it_${Math.floor(rnd() * 1e9).toString(36)}`;
  const brandsFor = DEMO_BRANDS.filter((b) => b.apcs.includes(u.key));

  // Attendance — value is filled in at read time from real attendance rows.
  items.push({
    id: id(), text: 'Attendance above 90%', amount: 8000,
    targetValue: 100, suffix: '%', completed: false, achievedValue: 0,
    completedBy: null, source: 'attendance',
  });

  const hitTarget = (b) => b.gmvAchieved >= b.gmvTarget;
  if (u.role === 'apc') {
    for (const b of brandsFor) {
      items.push({
        id: id(), text: `${b.name} — Total Revenue in GMV Max`, amount: 6000,
        targetValue: Math.round(b.gmvTarget / 1000) * 1000, suffix: '',
        completed: allDone || (closed && hitTarget(b)), achievedValue: 0,
        completedBy: closed && (allDone || hitTarget(b)) ? idOf.ol : null,
        source: 'gmv_max', brandId: brandId[b.key], brandName: b.name,
      });
    }
    items.push({
      id: id(), text: 'Publish 120+ creator videos this month', amount: 5000,
      targetValue: 120, suffix: '', completed: allDone || (closed && chance(0.7)),
      achievedValue: allDone ? int(126, 168) : int(84, 168),
      completedBy: closed ? idOf.ol : null,
    });
  }

  if (u.role === 'tl') {
    const owned = DEMO_BRANDS.filter((b) => b.owner === u.key);
    for (const b of owned.slice(0, 2)) {
      items.push({
        id: id(), text: `${b.name} — Total Revenue in GMV Max`, amount: 5000,
        targetValue: Math.round(b.gmvTarget / 1000) * 1000, suffix: '',
        completed: closed && hitTarget(b), achievedValue: 0,
        completedBy: closed && hitTarget(b) ? idOf.ol : null,
        source: 'gmv_max', brandId: brandId[b.key], brandName: b.name,
      });
    }
    // Commission Based Tier: the OL types a benchmark, the achieved figure and
    // a percentage; the payout is the excess times the percentage, converted to
    // PKR at the month's rate. One line here has NO benchmark, which is a real
    // mode of the feature — it pays on everything achieved.
    const cb = owned[0];
    items.push({
      id: id(), text: `${cb.name} — commission on GMV above benchmark`, amount: 0,
      targetValue: Math.round(cb.gmvTarget * 0.9), suffix: '',
      completed: false, achievedValue: Math.round(cb.gmvAchieved * (0.85 + rnd() * 0.3)),
      completedBy: null, source: 'commission_tier',
      brandId: brandId[cb.key], brandName: cb.name, commissionPct: 0.5,
    });
    if (owned[1]) {
      items.push({
        id: id(), text: `${owned[1].name} — commission on all GMV`, amount: 0,
        targetValue: 0, suffix: '',
        completed: false, achievedValue: Math.round(owned[1].gmvAchieved * 0.4),
        completedBy: null, source: 'commission_tier',
        brandId: brandId[owned[1].key], brandName: owned[1].name, commissionPct: 0.25,
      });
    }
  }

  if (u.role === 'ol') {
    for (const k of DEMO_OL_INCENTIVE_BRANDS) {
      const b = DEMO_BRANDS.find((x) => x.key === k);
      items.push({
        id: id(), text: `${b.name} — team incentive completion`, amount: 4000,
        targetValue: 70, suffix: '%', completed: closed && chance(0.7), achievedValue: 0,
        completedBy: null, source: 'ol_brands', brandId: brandId[k], brandName: b.name,
      });
    }
  }

  if (u.role === 'ads_manager') {
    for (const k of DEMO_ADS_BRANDS) {
      const b = DEMO_BRANDS.find((x) => x.key === k);
      items.push({
        id: id(), text: `${b.name} — Total Revenue in GMV Max`, amount: 2000,
        targetValue: Math.round(b.gmvTarget / 1000) * 1000, suffix: '',
        completed: closed && hitTarget(b), achievedValue: 0,
        completedBy: closed && hitTarget(b) ? idOf.ol : null,
        source: 'gmv_max', brandId: brandId[k], brandName: b.name,
      });
    }
  }

  if (u.role === 'ipc' || u.role === 'pctl') {
    items.push({
      id: id(), text: 'Close 6 paid collaborations', amount: 7000,
      targetValue: 6, suffix: '', completed: closed && chance(0.75),
      achievedValue: int(3, 9), completedBy: closed ? idOf.pctl : null,
    });
    items.push({
      id: id(), text: 'Keep average creator fee under budget', amount: 4000,
      targetValue: 100, suffix: '%', completed: closed && chance(0.6),
      achievedValue: int(78, 112), completedBy: closed ? idOf.pctl : null,
    });
  }

  return items;
}

async function seedIncentives() {
  console.log('\nIncentives');
  const people = DEMO_USERS.filter((u) => u.role !== 'boss' && u.role !== 'developer');
  const rows = [];
  for (let back = 2; back >= 0; back--) {
    const mk = monthKey(new Date(TODAY.getFullYear(), TODAY.getMonth() - back, 1));
    const closed = back > 0;
    for (const u of people) {
      rows.push({
        user_id: idOf[u.key],
        month: mk,
        basic_salary: u.salary,
        incentives: incentiveItems(u, mk, closed),
        bonuses: closed && chance(0.25)
          ? [{ id: `bn_${Math.floor(rnd() * 1e9).toString(36)}`, text: 'Spot bonus — exceptional month',
              amount: 10000, targetValue: 0, suffix: '', completed: true,
              achievedValue: 0, completedBy: idOf.boss }]
          : [],
        // Closed months are verified and paid; the current month is open, which
        // is the state the OL and Boss actually work in.
        verified: closed,
        ...(closed ? { verified_by: idOf.ol, verified_at: new Date(addDays(TODAY, -back * 30)).toISOString() } : {}),
        payout_cleared: back === 2,
        ...(back === 2 ? { payout_cleared_by: idOf.boss, payout_cleared_at: new Date(addDays(TODAY, -55)).toISOString() } : {}),
        last_updated_by: idOf.ol,
      });
    }
  }
  await insert('incentives', rows, { onConflict: 'user_id,month', chunk: 60 });
  log('incentive plans', rows.length);
}

// ── 9. Agenda + checkpoints ─────────────────────────────────────────────────
async function seedAgenda() {
  console.log('\nAgenda & checkpoints');
  await db.from('agenda_settings').upsert(
    { id: 1, meeting_day: 'tuesday', google_meet_link: 'https://meet.google.com/demo-agenda', updated_by: idOf.ol },
    { onConflict: 'id' },
  );
  const schedules = [
    { tl_id: idOf.tl_alpha, meeting_day: 'tuesday', meeting_time: '11:00', meet_link: 'https://meet.google.com/demo-alpha', updated_by: idOf.ol },
    { tl_id: idOf.tl_beta, meeting_day: 'wednesday', meeting_time: '11:00', meet_link: 'https://meet.google.com/demo-beta', updated_by: idOf.ol },
    { tl_id: idOf.pctl, meeting_day: 'thursday', meeting_time: '15:00', meet_link: 'https://meet.google.com/demo-paid', updated_by: idOf.ol },
  ];
  await insert('agenda_team_schedules', schedules, { onConflict: 'tl_id' });
  log('team schedules', schedules.length);

  const teams = [
    { tl: 'tl_alpha', apcs: ['apc_leo', 'apc_mira', 'apc_jonah'] },
    { tl: 'tl_beta', apcs: ['apc_ayesha', 'apc_ivan', 'apc_nadia'] },
    { tl: 'pctl', apcs: ['ipc_ruth', 'ipc_kai'] },
  ];
  const meetings = [];
  for (let back = 5; back >= 0; back--) {
    const ref = addDays(TODAY, -7 * back);
    const monday = addDays(ref, -((ref.getDay() + 6) % 7));
    for (const t of teams) {
      meetings.push({
        tl_id: idOf[t.tl],
        week_start: iso(monday),
        meeting_date: iso(addDays(monday, 1)),
        meeting_time: '11:00',
        status: back === 0 ? 'upcoming' : 'completed',
        ...(back > 0 ? {
          started_at: new Date(addDays(monday, 1)).toISOString(),
          finished_at: new Date(addDays(monday, 1)).toISOString(),
          started_by: idOf[t.tl], finished_by: idOf.ol,
          tl_rating: pick(['good', 'good', 'excellent']),
          tl_reporting_stars: pick([4, 4.5, 5]),
          tl_reviewed_by: idOf.ol,
        } : {}),
        _team: t,
      });
    }
  }
  const payload = meetings.map(({ _team, ...m }) => m);
  const { data: made, error } = await db.from('agenda_meetings').insert(payload).select('id, tl_id, week_start, status');
  if (error) throw new Error(`agenda_meetings: ${error.message}`);
  log('meetings', made.length);

  const pres = [];
  const weekly = [];
  for (const m of made) {
    const team = teams.find((t) => idOf[t.tl] === m.tl_id);
    for (const k of team.apcs) {
      const done = m.status === 'completed';
      pres.push({
        meeting_id: m.id, apc_id: idOf[k],
        status: done ? 'done' : 'pending',
        ...(done ? {
          started_at: new Date(m.week_start).toISOString(),
          ended_at: new Date(m.week_start).toISOString(),
          started_by: m.tl_id, reviewed_by: idOf.ol,
          overall_rating: pick(['good', 'good', 'excellent', 'average']),
          overall_summary: pick([
            'Solid week. Numbers held up and the creator pipeline is healthy.',
            'Behind on sampling but the campaign plan is sound.',
            'Excellent — beat target and the reporting was clean.',
          ]),
        } : {}),
      });
      // Weekly APC ratings: the month's performance score is the average of
      // these, so they need to exist for the performance screens to add up.
      if (done && ['apc', 'ipc'].includes(DEMO_USERS.find((u) => u.key === k).role)) {
        const base = k === STAR ? 0.93 : k === STRUGGLING ? 0.58 : 0.75 + rnd() * 0.15;
        const metrics = Object.fromEntries(
          METRIC_KEYS.map((mk2) => [mk2, Math.round(Math.min(1, Math.max(0.3, base + (rnd() - 0.5) * 0.16)) * 100)]),
        );
        weekly.push({
          meeting_id: m.id, apc_id: idOf[k], week_start: m.week_start,
          month: m.week_start.slice(0, 7),
          metrics,          // overall_score is generated, same as above
          rated_by: idOf.ol,
        });
      }
    }
  }
  await insert('agenda_presentations', pres);
  log('presentations', pres.length);
  await insert('weekly_performance_ratings', weekly);
  log('weekly APC ratings', weekly.length);

  const agTasks = [];
  for (const m of made.slice(-6)) {
    const team = teams.find((t) => idOf[t.tl] === m.tl_id);
    for (const k of team.apcs.slice(0, 2)) {
      agTasks.push({
        assignee_id: idOf[k], created_by: m.tl_id,
        title: pick(TASK_TITLES),
        details: 'Agreed in the weekly meeting.',
        status: pick(['todo', 'todo', 'completed']),
        due_date: iso(addDays(TODAY, int(1, 10))),
      });
    }
  }
  await insert('agenda_tasks', agTasks);
  log('agenda tasks', agTasks.length);

  // Weekly checkpoints — the per-brand deck the APC fills in before the meeting.
  const cps = [];
  for (let back = 3; back >= 0; back--) {
    const ref = addDays(TODAY, -7 * back);
    const monday = addDays(ref, -((ref.getDay() + 6) % 7));
    for (const b of DEMO_BRANDS) {
      const st = back === 0 ? pick(['draft', 'submitted']) : 'approved';
      cps.push({
        brand_id: brandId[b.key],
        week_start: iso(monday),
        week_label: `Week of ${MONTH_SHORT[monday.getMonth()]} ${monday.getDate()}`,
        author_id: idOf[b.apcs[0]],
        status: st,
        data: {
          gmv: String(Math.round(b.gmvAchieved / 4.3 * (0.7 + rnd() * 0.6))),
          creatorsOnboarded: String(int(4, 28)),
          samplesShipped: String(int(10, 70)),
          videosPosted: String(int(25, 180)),
          notes: 'Auto-generated sample checkpoint for the demo.',
        },
        ...(st !== 'draft' ? { submitted_at: new Date(addDays(monday, 1)).toISOString(), submitted_by: idOf[b.apcs[0]] } : {}),
        ...(st === 'approved' ? {
          verified_at: new Date(addDays(monday, 2)).toISOString(), verified_by: idOf[b.owner],
          approved_at: new Date(addDays(monday, 2)).toISOString(), approved_by: idOf.ol,
        } : {}),
      });
    }
  }
  await insert('weekly_checkpoints', cps, { onConflict: 'brand_id,week_start' });
  log('weekly checkpoints', cps.length);
}

// ── 10. Knowledge base ──────────────────────────────────────────────────────
async function seedKnowledge() {
  console.log('\nKnowledge base');
  const arts = [
    ['How we run the weekly client report', 'reporting',
     'Every brand gets a weekly report. Draft by Monday, submitted Tuesday, verified by the Team Lead, approved by the Operations Lead before it goes to the client.'],
    ['Creator outreach: the first message', 'outreach',
     'Keep it short. Name the product, name the commission, name the sample. Three sentences beats three paragraphs every time.'],
    ['Sample approval rules', 'operations',
     'Approve a sample when the creator has posted in the category before and their last three videos cleared 2,000 views. Otherwise ask for a pinned comment first.'],
    ['GMV Max: when to raise the budget', 'ads',
     'Raise only after three consecutive days above the target ROI, and never by more than 30% in one step.'],
    ['Attendance and clock-in', 'hr',
     'Clock in from the attendance page at the start of your shift. If you forget, raise an edit request the same day — your Team Lead can approve it.'],
    ['Leave policy', 'hr',
     'Annual leave needs a week of notice and a named cover. Sick leave can be filed the same day.'],
    ['What the star ratings mean', 'performance',
     'Reports are rated out of 5 by the Operations Lead. Three is a report that does the job. Five is one the client could read without a covering email.'],
    ['Escalating a stuck shipment', 'operations',
     'Chase the supplier once, then raise it in the Tuesday meeting. Do not let a stuck sample sit for a week in silence.'],
  ].map(([title, category, body]) => ({
    title, category, body,
    created_by: idOf.ol,
    approval_status: 'approved',
    approved_by: idOf.boss,
    approved_at: new Date(addDays(TODAY, -int(20, 90))).toISOString(),
    visibility: 'office',
    requires_ack: title.startsWith('Attendance') || title.startsWith('Leave'),
    tags: [category],
  }));
  await insert('kb_articles', arts);
  log('articles', arts.length);
}

// ── Run ─────────────────────────────────────────────────────────────────────
async function main() {
  if (RESET) await reset();
  await seedPeople();
  await seedBrands();
  await seedAttendance();
  await seedLeave();
  await seedTasks();
  await seedReports();
  await seedPerformance();
  await seedIncentives();
  await seedAgenda();
  await seedKnowledge();

  console.log('\nDone. Sign in at the demo URL with any of these:');
  for (const u of DEMO_USERS) {
    console.log(`  ${u.role.padEnd(12)} ${u.email.padEnd(38)} ${PASSWORD}`);
  }
}

main().catch((e) => { console.error('\nSEED FAILED:', e.message); process.exit(1); });
