// ============================================================
// Edge Function: video-review-seed  (Boss-only, one-off per brand)
//
// Seeds public.video_review_state so the ledger does not start empty.
//
// Without this, the first stateful run would see EVERY creator as owing all 3
// messages and hand the APC a backlog of hundreds of people it had already
// messaged by hand. So: every message whose due date falls ON OR BEFORE the
// cutoff is recorded as already sent (source='seed'). Anything due AFTER the
// cutoff is deliberately left unsent, so the tool catches it up on the next run
// — which is exactly how the creators lost to Euka's Jul-10 ingestion gap get
// recovered.
//
// The Boss set the cutoff to 2026-07-07 (the last date he is confident every VR
// message actually went out).
//
// CHEAP BY DESIGN. It does NOT walk each creator's history (that would be ~2,500
// creators x 13 calls for one brand). The store-wide `creator_videos` export
// returns creator_handle + posted_date for EVERY video in a date range, so three
// 70-day chunks (~210 days) reconstruct every creator's posting days in 3 calls.
//
// Known limitation, accepted: a creator whose 1st/2nd video predates the 210-day
// window AND who has fewer than 3 videos inside it will have msgs_sent
// under-counted, so they could receive one duplicate message. That needs someone
// with a years-old video and almost no activity since — rare, and a duplicate is
// far less harmful than the silent miss this whole change exists to kill.
//
// Deploy: supabase functions deploy video-review-seed
// Invoke: POST { brandId, cutoff: 'YYYY-MM-DD', dryRun?: boolean }
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const EUKA_BASE = 'https://api.euka.ai/v0';
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const addDays = (d: string, n: number) => {
  const x = new Date(d + 'T00:00:00Z');
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
const dayOf = (s: string) => String(s).slice(0, 10);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const maxDate = (a: string, b: string) => (a > b ? a : b);
const isValidDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));

function eukaKeyForSlug(slug: string): string {
  if (slug === 'solidgold') return Deno.env.get('EUKA_API_KEY') || '';
  const own = Deno.env.get(`EUKA_API_KEY_${slug.toUpperCase()}`);
  if (own) return own;
  return Deno.env.get('EUKA_SHARED_API_KEY') || '';
}

async function eukaGet(path: string, key: string): Promise<any> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(EUKA_BASE + path, {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      });
      const text = await r.text();
      let data: any;
      try { data = JSON.parse(text); } catch { data = text; }
      if (r.ok && !data?.error) return data;
      lastErr = data?.error || `HTTP ${r.status}`;
      if (r.status === 400) return data;
    } catch (e) { lastErr = e; }
    await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
  }
  throw new Error(`Euka request failed: ${String(lastErr)}`);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token) return json({ error: 'unauthenticated' }, 401);

    // This is a one-off admin backfill with no UI, so it also accepts a
    // service-role token — which already grants full DB access, so it grants
    // nothing extra here. Check the JWT's role CLAIM rather than comparing to
    // the env key (they can drift after a key rotation). Supabase's gateway has
    // already verified the signature before we ever see it, so trusting the
    // decoded claim is sound. Any other caller must be the Boss.
    const claimRole = (() => {
      try {
        const p = token.split('.')[1];
        if (!p) return '';
        const pad = p.replace(/-/g, '+').replace(/_/g, '/');
        return JSON.parse(atob(pad + '='.repeat((4 - pad.length % 4) % 4)))?.role || '';
      } catch { return ''; }
    })();

    if (token !== SERVICE_ROLE && claimRole !== 'service_role') {
      const { data: userData } = await admin.auth.getUser(token);
      if (!userData?.user) return json({ error: 'unauthenticated' }, 401);
      const { data: me } = await admin
        .from('profiles').select('role').eq('id', userData.user.id).maybeSingle();
      if (String(me?.role || '').toLowerCase() !== 'boss') {
        return json({ error: 'forbidden — Boss only' }, 403);
      }
    }

    const payload = await req.json().catch(() => ({}));
    const brandId = String(payload?.brandId || '').trim();
    const cutoff = String(payload?.cutoff || '').trim();
    const dryRun = payload?.dryRun === true;
    if (!brandId) return json({ error: 'brandId is required' }, 400);
    if (!isValidDate(cutoff)) return json({ error: 'cutoff must be YYYY-MM-DD' }, 400);

    const { data: brand } = await admin
      .from('brands').select('id, brand_name, euka_store_id, euka_slug').eq('id', brandId).maybeSingle();
    if (!brand) return json({ error: 'brand not found' }, 404);
    if (!brand.euka_store_id || !brand.euka_slug) {
      return json({ error: `"${brand.brand_name}" is not linked to a Euka store.` }, 400);
    }
    const storeId = String(brand.euka_store_id);
    const key = eukaKeyForSlug(String(brand.euka_slug));
    if (!key) return json({ error: `Euka key not configured for "${brand.brand_name}".` }, 500);

    // ── Reconstruct every creator's posting days from 3 store-wide chunks ──
    // creator_videos returns creator_handle + posted_date per video, and the
    // export caps a call at 70 days — so 3 chunks ≈ 210 days back from cutoff.
    const byHandle = new Map<string, string[]>();
    let end = cutoff;
    for (let i = 0; i < 3; i++) {
      const start = addDays(end, -69);
      const r = await eukaGet(
        `/data-export?type=creator_videos&store_id=${storeId}` +
        `&start_date=${start}&end_date=${end}&export_type=json`,
        key,
      );
      for (const v of (Array.isArray(r?.data) ? r.data : [])) {
        const h = v?.creator_handle;
        const d = v?.posted_date ? dayOf(v.posted_date) : '';
        if (!h || !d || d > cutoff) continue;
        if (!byHandle.has(h)) byHandle.set(h, []);
        byHandle.get(h)!.push(d);
      }
      end = addDays(start, -1);
    }

    // ── Derive how many messages had already fallen due by the cutoff ──
    // Same send-date chain the live run uses: one message per day, in sequence.
    const rows: any[] = [];
    for (const [handle, daysRaw] of byHandle) {
      const days = daysRaw.slice().sort(cmp);          // one entry PER VIDEO
      const [D1, D2, D3] = days;
      const s1 = D1 || null;
      const s2 = D2 ? maxDate(D2, addDays(s1!, 1)) : null;
      const s3 = D3 ? maxDate(D3, addDays(s2!, 1)) : null;

      let sent = 0;
      if (s1 && s1 <= cutoff) sent = 1;
      if (s2 && s2 <= cutoff) sent = 2;
      if (s3 && s3 <= cutoff) sent = 3;

      rows.push({
        brand_id: brandId,
        creator_handle: handle,
        video_days: days.slice(0, 3),
        video_count: days.length,
        msgs_sent: sent,
        last_sent_on: sent === 3 ? s3 : sent === 2 ? s2 : sent === 1 ? s1 : null,
        msg1_on: sent >= 1 ? s1 : null,
        msg2_on: sent >= 2 ? s2 : null,
        msg3_on: sent >= 3 ? s3 : null,
        source: 'seed',
        walked_at: new Date().toISOString(),
      });
    }

    const dist = { 0: 0, 1: 0, 2: 0, 3: 0 } as Record<number, number>;
    for (const r of rows) dist[r.msgs_sent]++;

    if (dryRun) {
      return json({
        dryRun: true, brand: brand.brand_name, cutoff,
        creators: rows.length, msgsSentDistribution: dist,
        sample: rows.slice(0, 5),
      });
    }

    // Upsert in batches. onConflict on the PK so re-running is safe.
    let written = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      const { error } = await admin
        .from('video_review_state')
        .upsert(batch, { onConflict: 'brand_id,creator_handle' });
      if (error) throw new Error(error.message);
      written += batch.length;
    }

    return json({
      brand: brand.brand_name, cutoff, creatorsSeeded: written,
      msgsSentDistribution: dist,
      note: 'Messages due AFTER the cutoff were deliberately NOT marked sent — the next run will catch them up.',
    });
  } catch (err) {
    console.error('video-review-seed failed:', err);
    return json({ error: String(err) }, 500);
  }
});
