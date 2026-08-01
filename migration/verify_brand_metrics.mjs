import { sb } from './lib/supabase.js';
import { createClient } from '@supabase/supabase-js';
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '..', '.env.local') });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK  ', m); } else { fail++; console.log('  FAIL', m); } };

const { data: brand } = await sb.from('brands').select('id, brand_name').limit(1).single();
console.log('Using brand:', brand.brand_name, '\n');
const B = brand.id, MK = '2099-01';   // far-future month so it can't collide with real data

await sb.from('brand_monthly_metrics').delete().eq('brand_id', B).eq('month_key', MK);

let r = await sb.from('brand_monthly_metrics').upsert(
  { brand_id: B, month_key: MK, gmv_target: 20000, gmv_achieved: 15300, roi_target: 2.7, roi_achieved: 2.5 },
  { onConflict: 'brand_id,month_key' });
ok(!r.error, 'insert metrics ' + (r.error?.message || ''));

r = await sb.from('brand_monthly_metrics').select('gmv_target, gmv_achieved, roi_target').eq('brand_id', B).eq('month_key', MK).single();
ok(Number(r.data?.gmv_target) === 20000 && Number(r.data?.gmv_achieved) === 15300, 'read back gmv 20000/15300');
ok(Number(r.data?.roi_target) === 2.7, 'read back roi_target 2.7');

// upsert advances (no duplicate)
r = await sb.from('brand_monthly_metrics').upsert(
  { brand_id: B, month_key: MK, gmv_achieved: 18000 }, { onConflict: 'brand_id,month_key' });
ok(!r.error, 'upsert update gmv_achieved');
r = await sb.from('brand_monthly_metrics').select('gmv_achieved').eq('brand_id', B).eq('month_key', MK).single();
ok(Number(r.data?.gmv_achieved) === 18000, 'gmv_achieved now 18000 (single row)');

// bad month_key rejected by CHECK
r = await sb.from('brand_monthly_metrics').insert({ brand_id: B, month_key: '2026-7' });
ok(!!r.error, "month_key '2026-7' rejected by CHECK (" + (r.error ? 'blocked' : 'LEAKED') + ')');

// RLS: anon sees nothing / cannot write
const anonKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
if (anonKey) {
  const anon = createClient(process.env.VITE_SUPABASE_URL, anonKey, { auth: { persistSession: false } });
  const a1 = await anon.from('brand_monthly_metrics').select('brand_id').limit(3);
  ok((a1.data?.length || 0) === 0, 'anon reads 0 rows (RLS on): ' + (a1.error ? 'err ' + a1.error.code : (a1.data?.length ?? '?')));
  const a2 = await anon.from('brand_monthly_metrics').insert({ brand_id: B, month_key: MK, gmv_target: 1 });
  ok(!!a2.error, 'anon insert blocked (' + (a2.error ? a2.error.code : 'LEAKED') + ')');
} else {
  console.log('  (no anon key — skipped RLS anon checks)');
}

await sb.from('brand_monthly_metrics').delete().eq('brand_id', B).eq('month_key', MK);
const c = await sb.from('brand_monthly_metrics').select('month_key').eq('brand_id', B).eq('month_key', MK);
ok((c.data?.length || 0) === 0, 'cleanup: test row removed');

console.log(`\n${fail === 0 ? 'ALL GOOD' : 'HAS FAILURES'} — pass ${pass}, fail ${fail}`);
