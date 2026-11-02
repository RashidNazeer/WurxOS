// Snapshot-backed Db for the data tools: the repo's fakeDb over the JSON taken by snapshot.mjs.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeDb } from '../../../supabase/functions/_shared/ai/__tests__/fixtures/fakeDb.ts';

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '.snapshot');
export const hasSnapshot = () => existsSync(resolve(dir, 'tables.json'));

export function loadSnapshot() {
  if (!hasSnapshot()) throw new Error('No snapshot. Run: node wurx-buddy/tests/truth/snapshot.mjs');
  const tables = JSON.parse(readFileSync(resolve(dir, 'tables.json'), 'utf8'));
  const rpcData = JSON.parse(readFileSync(resolve(dir, 'rpc.json'), 'utf8'));
  // reports.brand_id embeds: fakeDb resolves `brand:brand_id(...)` against brands.
  const rpc = {
    get_performance_composite: ({ p_user, p_month }) => { const c = rpcData.composite[`${p_user}|${p_month}`]; return c ? [c] : []; },
    attendance_month_breakdown_bulk: ({ p_month, p_user_ids }) => (rpcData.breakdown[p_month] || []).filter((b) => !p_user_ids || p_user_ids.includes(b.user_id)),
    incentive_attendance_pct: ({ p_month, p_user_ids }) => (rpcData.breakdown[p_month] || []).filter((b) => !p_user_ids || p_user_ids.includes(b.user_id)).map((b) => ({ user_id: b.user_id, pct: b.pct })),
  };
  return { tables, rpcData, db: fakeDb(tables, rpc), takenAt: rpcData.takenAt };
}

export const bossCtx = () => ({ userId: '00000000-0000-0000-0000-000000000000', role: 'boss' });
