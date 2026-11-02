// Pseudonymises the production snapshot for the LLM leg of the truth eval, so a free-tier model endpoint (Gemini, Groq,
// NVIDIA: not where payroll belongs, see QA F8) never sees a real person, real pay or a real client.
// Deterministic: same snapshot in, same fake world out. Truth for that leg is computed FROM the fake world.
// Output: .snapshot/pseudo-tables.json + .snapshot/pseudo-rpc.json (gitignored with the rest of .snapshot/).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '.snapshot');
const FIRST = ['Alma', 'Bruno', 'Carla', 'Dario', 'Elena', 'Farid', 'Gita', 'Hugo', 'Irina', 'Jonas', 'Kira', 'Leon', 'Mira', 'Nico', 'Olga', 'Pavel', 'Quinn', 'Rosa', 'Sven', 'Tara', 'Uma', 'Viktor', 'Wanda', 'Xavi', 'Yara', 'Zane', 'Anika', 'Boris', 'Cleo', 'Dmitri', 'Esme', 'Felix', 'Greta', 'Hakon', 'Ines', 'Joel', 'Kaya', 'Lars', 'Maren', 'Nils', 'Orla', 'Pia', 'Rafa', 'Siri', 'Theo', 'Una', 'Vera'];
const LAST = ['Arden', 'Bishop', 'Calder', 'Dunmore', 'Everly', 'Fenwick', 'Garrow', 'Hale', 'Ivers', 'Jarrow', 'Kestrel', 'Lowell', 'Merrow', 'Norland', 'Oakes', 'Pryor', 'Quill', 'Rowan', 'Sable', 'Thorne', 'Ulmer', 'Vance', 'Wren', 'Yarrow', 'Zeller', 'Ashby', 'Brandt', 'Corwin', 'Delmar', 'Eastly', 'Foyle', 'Gantry', 'Harlow', 'Imber', 'Juniper', 'Kellan', 'Larkin', 'Mosby', 'Nash', 'Orrin', 'Pell', 'Rudd', 'Stroud', 'Tarn', 'Vail', 'Wick', 'Yore'];

export function pseudonymise() {
  const T = JSON.parse(readFileSync(resolve(dir, 'tables.json'), 'utf8'));
  const R = JSON.parse(readFileSync(resolve(dir, 'rpc.json'), 'utf8'));
  const name = new Map();
  T.profiles.forEach((p, i) => name.set(p.id, `${FIRST[i % FIRST.length]} ${LAST[(i * 7 + 3) % LAST.length]}`));
  const money = (v, k = 0.83) => (v == null ? v : Math.round((Number(v) * k) / 500) * 500);
  const bname = new Map();
  T.brands.forEach((b, i) => bname.set(b.id, `Brand ${String(i + 1).padStart(2, '0')}`));
  const out = { ...T };
  out.profiles = T.profiles.map((p) => ({ ...p, display_name: name.get(p.id), email: null, avatar_url: null, responsibilities: null, permissions: null, notification_prefs: null, menu_layout: null }));
  out.employee_compensation = T.employee_compensation.map((c) => ({ ...c, basic_salary: money(c.basic_salary), last_change_reason: null }));
  out.salary_history = T.salary_history.map((c) => ({ ...c, previous_amount: money(c.previous_amount), new_amount: money(c.new_amount), change_reason: null }));
  out.incentives = T.incentives.map((r) => ({
    ...r, basic_salary: money(r.basic_salary),
    incentives: (r.incentives || []).map((g) => ({ ...g, amount: money(g.amount), brandId: null })),
    bonuses: (r.bonuses || []).map((g) => ({ ...g, amount: money(g.amount), brandId: null })),
  }));
  out.performance_flags = T.performance_flags.map((f) => ({ ...f, reason: 'Flag note (text removed).' }));
  out.performance_warnings = T.performance_warnings.map((f) => ({ ...f, reason: 'Warning note (text removed).' }));
  out.leave_requests = T.leave_requests.map((l) => ({ ...l, reason: 'Reason (text removed).', decision_note: null, decisions: null, other_title: l.other_title ? 'Other' : null }));
  out.agenda_tasks = T.agenda_tasks.map((t) => ({ ...t, title: 'Agenda task', details: '', link: null }));
  out.brands = T.brands.map((b) => ({ ...b, brand_name: bname.get(b.id), client_name: null, logo_url: null, euka_slug: null, euka_store_id: null, reacher_shop_id: null }));
  out.brand_monthly_metrics = T.brand_monthly_metrics.map((m) => ({ ...m, gmv_target: money(m.gmv_target, 0.5), gmv_achieved: money(m.gmv_achieved, 0.5) }));
  out.gmv_max_reports = [];
  // reports: keep the headline numbers (scaled), drop every word and every real creator handle
  const scale = (v) => { const n = Number(String(v ?? '').replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) && String(v ?? '').trim() !== '' ? String(Math.round(n * 0.61 * 100) / 100) : v; };
  out.reports = T.reports.filter((r) => r.period_start >= '2026-08-01').map((r) => {
    const d = r.data || {};
    const keep = (o, keys) => (o ? Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, scale(o[k])])) : undefined);
    return {
      ...r, period_label: r.period_label, author_id: null,
      data: {
        overallPerformance: keep(d.overallPerformance, ['gmv', 'affiliateGmv', 'orders', 'samplesApproved', 'videosPosted', 'roi', 'shopPerformanceScore']),
        keyMetrics: keep(d.keyMetrics, ['gmv', 'orders']), totalSales: keep(d.totalSales, ['monthGmv']),
        topCreators: (d.topCreators || []).slice(0, 5).map((c, i) => ({ ...(c.name ? { name: `creator_${i + 1}` } : { username: `@creator_${i + 1}` }), gmv: scale(c.gmv), ...(c.itemsSold !== undefined ? { itemsSold: scale(c.itemsSold), videosPosted: scale(c.videosPosted) } : {}) })),
      },
    };
  });
  const rpc = JSON.parse(JSON.stringify(R));
  writeFileSync(resolve(dir, 'pseudo-tables.json'), JSON.stringify(out));
  writeFileSync(resolve(dir, 'pseudo-rpc.json'), JSON.stringify(rpc));
  return { people: name.size, brands: bname.size, reports: out.reports.length };
}

if (process.argv[1] && process.argv[1].endsWith('pseudo.mjs')) console.log(pseudonymise());
