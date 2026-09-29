// Role rules for the data tools. The tools read with the service role (as v1
// does), so every tool enforces the caller's access itself, using the same
// SQL helpers RLS uses (can_view_brand), never a hand-written copy.

import type { Db, ToolCtx } from './types.ts';

export const isBoss = (ctx: ToolCtx) => String(ctx.role || '').toLowerCase() === 'boss';
// True when the database's own RLS already filters every read (caller's JWT).
export const rlsDecides = (ctx: ToolCtx) => !isBoss(ctx) && !!ctx.userClient;

// public.ai_viewable_brand_ids(p_uid) (Engineer 1's migration) answers in one
// round trip. Until it exists, fall back to one can_view_brand call per brand.
// Detected once per process: null = not yet known.
let setRpc: boolean | null = null;
export const _resetAclProbe = () => { setRpc = null; };   // tests

// PostgREST: PGRST202 = function not in the schema cache; 42883 = undefined function.
const isMissingFn = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === 'PGRST202' || e.code === '42883' || /could not find the function/i.test(String(e.message)));

async function viaRpc(admin: Db, uid: string): Promise<Set<string> | null> {
  if (setRpc === false) return null;
  let data: unknown[] | null = null, error: { code?: string; message?: string } | null = null;
  try { ({ data, error } = await admin.rpc('ai_viewable_brand_ids', { p_uid: uid })); } catch { return null; }
  if (error) {
    if (isMissingFn(error)) setRpc = false;
    return null;   // transient error: use the loop this time, probe again later
  }
  setRpc = true;
  // setof uuid comes back as bare strings; tolerate {ai_viewable_brand_ids: id} too.
  return new Set((data || []).map((x: unknown) => (typeof x === 'string' ? x : (x as Record<string, string>)?.ai_viewable_brand_ids)).filter(Boolean));
}

async function viaLoop(admin: Db, uid: string): Promise<Set<string>> {
  const { data: brands, error } = await admin.from('brands').select('id, owner_id').limit(1000);
  if (error) throw error;
  const check = async (b: { id: string; owner_id: string | null }, tries = 3): Promise<string | null> => {
    try {
      const { data, error: e } = await admin.rpc('can_view_brand', { b_owner: b.owner_id, b_id: b.id, uid });
      if (e) throw e;
      return data === true ? b.id : null;
    } catch (e) {
      // Intermittent "fetch failed" on dev (flaky link); an ACL answer must
      // not silently become "no brands", so retry, then fail the tool.
      if (tries > 1) { await new Promise((r) => setTimeout(r, 300)); return check(b, tries - 1); }
      throw e;
    }
  };
  // Small batches: 40 parallel calls made fetch fail on dev.
  const list = brands || [];
  const out: (string | null)[] = [];
  for (let i = 0; i < list.length; i += 6) out.push(...await Promise.all(list.slice(i, i + 6).map((b: any) => check(b))));
  return new Set(out.filter((x): x is string => !!x));
}

// Brands the caller may see: null = all (Boss). Memoised per ctx, i.e. per request.
const memo = new WeakMap<ToolCtx, Promise<Set<string> | null>>();

export function viewableBrandIds(admin: Db, ctx: ToolCtx): Promise<Set<string> | null> {
  if (isBoss(ctx)) return Promise.resolve(null);
  let p = memo.get(ctx);
  if (!p) {
    // With the caller's JWT client, brands_select (= can_view_brand) decides.
    p = ctx.userClient
      ? (async () => {
        const { data, error } = await ctx.userClient.from('brands').select('id').limit(1000);
        if (error) throw error;
        return new Set<string>((data || []).map((b: { id: string }) => b.id));
      })()
      : (async () => (await viaRpc(admin, ctx.userId)) ?? viaLoop(admin, ctx.userId))();
    memo.set(ctx, p);
  }
  return p;
}

// Narrows candidate brand ids to what the caller may see (null = unrestricted).
export function allowed(ids: string[] | null, visible: Set<string> | null): string[] | null {
  if (!visible) return ids;
  return (ids ?? [...visible]).filter((id) => visible.has(id));
}
