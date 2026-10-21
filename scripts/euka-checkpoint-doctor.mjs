// ============================================================
// Why can't this person auto-fill Euka on the Weekly Checkpoint?
//
//   node scripts/euka-checkpoint-doctor.mjs                  every APC/IPC, summary
//   node scripts/euka-checkpoint-doctor.mjs "Hamza Babar"    one person, full chain
//
// Walks the EXACT preconditions euka-checkpoint-autofill enforces, in its own
// order, and names the first one that fails. Read-only; writes nothing.
//
// The checks mirror supabase/functions/euka-checkpoint-autofill/index.ts:
//   1. profile exists and is_active            -> 403 "Your account is not active."
//   2. brand.euka_store_id AND euka_slug set   -> 400 "not linked to a Euka store"
//      (the CLIENT skips the call entirely when euka_store_id is null, so the
//       button reads "Auto-fill" with no "+ Euka" and nothing is attempted)
//   3. boss | ol | brand.owner_id = me | brand_assignments row
//                                              -> 403 "You do not have access"
//   4. a Euka API key for the brand's slug      -> 500 "Euka key not configured"
//   5. euka_stores.euka_brand_id for the store  -> 200 but targetInvites = null
//
// Check 3 is DELIBERATELY narrower than public.can_view_brand, which also
// grants sight via permissions.canViewAllBrands, pctl role,
// pctl_brand_selections and ads_manager_brands. Anyone reaching a brand by one
// of those routes can pick it on the page and still be refused by the function.
// That gap is reported below as VISIBLE-BUT-REFUSED.
//
// Step 4 cannot be checked from here: the keys are Edge Function secrets, not
// database rows. Everything else is.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
const REF = 'xoaaidgvblondjpvxjqp';

const envFile = path.join(ROOT, '.env.production');
if (!fs.existsSync(envFile)) {
  console.error('Missing ' + envFile + ' containing SUPABASE_ACCESS_TOKEN=sbp_...');
  process.exit(1);
}
const TOKEN = (fs.readFileSync(envFile, 'utf8').match(/SUPABASE_ACCESS_TOKEN=(.+)/) || [])[1];
if (!TOKEN) { console.error('No SUPABASE_ACCESS_TOKEN in .env.production'); process.exit(1); }

async function q(sql) {
  const res = await fetch('https://api.supabase.com/v1/projects/' + REF + '/database/query', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN.trim(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error('HTTP ' + res.status + ' — ' + text.slice(0, 400));
  const j = JSON.parse(text);
  return Array.isArray(j) ? j : (j.result ?? j.rows ?? j.data ?? []);
}
const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";

const who = process.argv.slice(2).find((a) => !a.startsWith('--')) || null;

// ---- A. the people -----------------------------------------------------
const people = await q(
  "select p.id::text, p.display_name, p.email, p.role, p.is_active," +
  " (p.deleted_at is not null) as deleted," +
  " coalesce((p.permissions->>'canViewAllBrands')::boolean,false) as can_view_all" +
  " from public.profiles p" +
  (who
    ? " where lower(trim(p.display_name)) = lower(trim(" + lit(who) + "))" +
      " or lower(p.email) = lower(" + lit(who) + ")"
    : " where p.role in ('apc','ipc') and p.is_active and p.deleted_at is null") +
  " order by p.display_name");

if (!people.length) { console.error('No profile matched ' + (who ? lit(who) : '(any active APC/IPC)')); process.exit(1); }
if (who && people.length > 1) {
  console.error('Ambiguous — ' + people.length + ' profiles matched:');
  console.table(people);
  process.exit(1);
}

// ---- B. brands they can SEE vs brands the function would ALLOW ---------
const ids = people.map((p) => lit(p.id)).join(',');
const rows = await q(
  "select pr.display_name as person, pr.role, b.brand_name, b.status," +
  " (b.euka_store_id is not null) as has_store_id," +
  " (b.euka_slug is not null) as has_slug," +
  " b.euka_slug," +
  " (b.owner_id = pr.id) as is_owner," +
  " exists (select 1 from public.brand_assignments ba where ba.brand_id = b.id and ba.user_id = pr.id) as assigned," +
  " coalesce(es.euka_brand_id is not null, false) as store_mapped," +
  " public.can_view_brand(b.owner_id, b.id, pr.id) as can_see" +
  " from public.profiles pr" +
  " cross join public.brands b" +
  " left join public.euka_stores es on es.store_id = b.euka_store_id" +
  " where pr.id in (" + ids + ") and b.status = 'active'" +
  "   and public.can_view_brand(b.owner_id, b.id, pr.id)" +
  " order by pr.display_name, b.brand_name");

const fnAllows = (r) => r.role === 'boss' || r.role === 'ol' || r.is_owner || r.assigned;

const verdict = (r) => {
  if (!r.has_store_id) return 'NO EUKA LINK — button shows plain "Auto-fill", no call is made';
  if (!r.has_slug) return 'euka_store_id set but euka_slug NULL -> 400 not linked';
  if (!fnAllows(r)) return 'VISIBLE-BUT-REFUSED -> 403 "You do not have access to this brand."';
  if (!r.store_mapped) return 'OK to call, but euka_stores.euka_brand_id MISSING -> invites come back null';
  return 'should work';
};

const out = rows.map((r) => ({
  person: r.person, role: r.role, brand: r.brand_name,
  euka: r.has_store_id ? (r.euka_slug || '(no slug)') : '-',
  owner: r.is_owner, assigned: r.assigned, store_mapped: r.store_mapped,
  verdict: verdict(r),
}));

console.table(out);

const bad = out.filter((r) => r.verdict !== 'should work');
console.log('\n' + out.length + ' visible brand(s); ' + bad.length + ' with a problem.');
for (const b of bad) console.log('  - ' + b.person + ' / ' + b.brand + ': ' + b.verdict);
if (!bad.length) {
  console.log('Every precondition in the database is satisfied. That leaves only the two');
  console.log('things not visible from here: the Euka API key secret for the slug, and');
  console.log('whatever Euka itself returns. Check the Edge Function logs next.');
}

// Also save it, so the result can be read back without copying a wide table.
const outFile = path.join(os.homedir(), 'Downloads', 'euka-doctor.json');
fs.writeFileSync(outFile, JSON.stringify({ people, brands: out, problems: bad }, null, 2), 'utf8');
console.log('\nSaved: ' + outFile);
