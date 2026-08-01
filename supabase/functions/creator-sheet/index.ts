// ============================================================
// Edge Function: creator-sheet
//
// Bridges the OS and the ONE shared creator sheet the IPCs manage. Two actions:
//
//   { action: 'read' }  (default)
//     Returns the sheet rows SCOPED TO THE CALLER'S BRANDS. Prefers a live Apps
//     Script web app (instant, no publish lag); falls back to the published CSV.
//     Rows for brands the caller can't view are dropped SERVER-SIDE (caller's own
//     JWT + brands RLS = can_view_brand) — the sheet carries PayPal/Discord PII,
//     so this must never be client-side only.
//
//   { action: 'write', brandId, handle, note }
//     Mirrors the OS approval state back into the sheet's Status column (and the
//     note into the Notes column) via the Apps Script web app. The status text is
//     recomputed server-side from creator_approvals (authoritative), not trusted
//     from the client. No-op if no webhook is configured.
//
// Returns (read): { headers, rows, unmatched, fetchedAt, source }
// Deploy: supabase functions deploy creator-sheet
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY     = Deno.env.get('SUPABASE_ANON_KEY')!;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const bkey = (s: string) => String(s ?? '').trim().toLowerCase();
const normHandle = (h: string) => String(h ?? '').trim().replace(/^@+/, '').toLowerCase();

// Plain-text status written back to the sheet — mirrors creatorStatus/
// sheetStatusText on the client. OL is the top level, so its decision wins.
function statusText(a: Record<string, unknown> | null): string {
  if (a?.ol_approved_by) return 'Approved by Operation Lead';
  if (a?.ol_rejected_by) return 'Rejected by Operation Lead';
  if (a?.tl_approved_by) return 'Approved by Team Lead';
  if (a?.tl_rejected_by) return 'Rejected by Team Lead';
  return 'Pending';
}

// RFC-4180-ish CSV parser: quoted fields, escaped quotes (""), commas/newlines in quotes.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const s = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
    else field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// POST JSON to the Apps Script web app (follows the 302 → googleusercontent).
async function callWebhook(url: string, payload: unknown): Promise<any> {
  const resp = await fetch(url, {
    method: 'POST', redirect: 'follow',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const txt = await resp.text();
  if (!resp.ok) throw new Error(`webhook ${resp.status}: ${txt.slice(0, 200)}`);
  try { return JSON.parse(txt); } catch { throw new Error(`webhook returned non-JSON: ${txt.slice(0, 200)}`); }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const authHeader = req.headers.get('Authorization') || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: 'unauthorized' }, 401);

    const body = await req.json().catch(() => ({}));
    const action = body?.action || 'read';

    // A client bound to the CALLER'S JWT so the brands RLS (can_view_brand) does
    // the scoping for us.
    const asUser = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: authHeader } },
    });

    const { data: cfg } = await admin
      .from('creator_library_config')
      .select('sheet_url, sheet_webhook_url, sheet_webhook_secret')
      .eq('id', 1).maybeSingle();
    const csvUrl  = (cfg?.sheet_url || '').trim();
    const hookUrl = (cfg?.sheet_webhook_url || '').trim();
    const secret  = cfg?.sheet_webhook_secret || '';

    // ── WRITE: mirror OS status back into the sheet ──────────────────────────
    if (action === 'write') {
      const brandId = body?.brandId;
      const handle  = normHandle(body?.handle || '');
      if (!brandId || !handle) return json({ error: 'brandId and handle required' }, 400);
      if (!hookUrl) return json({ ok: true, skipped: 'no-webhook' });

      // Access check — the caller must be able to view this brand.
      const { data: okBrand } = await asUser.from('brands').select('brand_name').eq('id', brandId).maybeSingle();
      if (!okBrand) return json({ error: 'no access to this brand' }, 403);

      // Recompute the status server-side (don't trust the client).
      const { data: appr } = await admin.from('creator_approvals')
        .select('tl_approved_by, tl_rejected_by, ol_approved_by, ol_rejected_by')
        .eq('brand_id', brandId).eq('tiktok_handle', handle).maybeSingle();
      const status = statusText(appr);

      try {
        const out = await callWebhook(hookUrl, {
          secret, action: 'write',
          brand: okBrand.brand_name, handle, status, note: (body?.note || '').trim(),
        });
        return json({ ok: true, status, webhook: out });
      } catch (e) {
        return json({ ok: false, status, error: String(e?.message || e) }, 502);
      }
    }

    // ── READ: fetch rows, then scope to the caller's brands ──────────────────
    const { data: myBrands, error: bErr } = await asUser
      .from('brands').select('brand_name').eq('status', 'active');
    if (bErr) return json({ error: `brand scope failed: ${bErr.message}` }, 500);
    const viewable = new Set((myBrands || []).map((b) => bkey(b.brand_name)));

    const { data: allBrands } = await admin.from('brands').select('brand_name').eq('status', 'active');
    const known = new Set((allBrands || []).map((b) => bkey(b.brand_name)));

    let headers: string[] = [];
    let allRows: Record<string, string>[] = [];
    let source = '';

    // Prefer the live Apps Script web app; fall back to the published CSV.
    if (hookUrl) {
      try {
        const out = await callWebhook(hookUrl, { secret, action: 'read' });
        headers = (out?.headers || []).map((h: string) => String(h ?? '').trim());
        allRows = (out?.rows || []).map((r: Record<string, unknown>) => {
          const o: Record<string, string> = {};
          for (const k of Object.keys(r)) o[String(k).trim()] = String(r[k] ?? '').trim();
          return o;
        });
        source = 'webhook';
      } catch (e) {
        if (!csvUrl) return json({ error: `Live sheet fetch failed: ${String(e?.message || e)}` }, 502);
        source = 'csv-fallback';
      }
    }

    if (!source || source === 'csv-fallback') {
      if (!csvUrl) return json({ error: 'No creator-library sheet is configured yet.' }, 400);
      const bust = csvUrl + (csvUrl.includes('?') ? '&' : '?') + '_cb=' + Date.now();
      const resp = await fetch(bust, {
        redirect: 'follow', cache: 'no-store',
        headers: { Accept: 'text/csv', 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
      });
      if (!resp.ok) return json({ error: `Sheet fetch failed (${resp.status}).` }, 502);
      const grid = parseCsv(await resp.text()).filter((r) => r.some((c) => (c ?? '').trim() !== ''));
      if (!grid.length) return json({ headers: [], rows: [], unmatched: 0, fetchedAt: new Date().toISOString(), source: source || 'csv' });
      headers = grid[0].map((h) => (h ?? '').trim());
      allRows = grid.slice(1).map((raw) => {
        const o: Record<string, string> = {};
        headers.forEach((h, i) => { o[h] = (raw[i] ?? '').trim(); });
        return o;
      });
      source = source || 'csv';
    }

    // Scope by the "Brand" column to the caller's viewable brands.
    const brandHeader = headers.find((h) => h.toLowerCase() === 'brand') || 'Brand';
    const rows: Record<string, string>[] = [];
    let unmatched = 0;
    for (const r of allRows) {
      const key = bkey(r[brandHeader]);
      if (viewable.has(key)) rows.push(r);
      else if (key && !known.has(key)) unmatched += 1;   // typo hint (admins only)
      // else: a real brand the caller can't view → dropped silently.
    }
    return json({ headers, rows, unmatched, fetchedAt: new Date().toISOString(), source });
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
});
