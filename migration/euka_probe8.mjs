// Euka MCP probe #8 — ask query_store_data for the EXACT Performance
// Overview dashboard tiles, with an explicit date range and the
// dashboard's own metric names, told to match the dashboard. Compare
// against the known 7-day dashboard values (May 12-18, 2026):
//   Total GMV $5,050 · Affiliate GMV $3,480 · Orders 163 · AOV $30.97
//   Video Views 461,320 · Samples Shipped 168 · Videos Posted 262
//   EMV $1,380 · Total Value Driven $4,870 · Video Conv 3.0%
import fs from 'fs';

const MCP_URL = 'https://app.euka.ai/api/mcp';
const env = {};
fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split(/\r?\n/).forEach((line) => {
  const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
});
const TOKEN = env.EUKA_TOKEN;

let sessionId = null;
let idCounter = 0;
function parseBody(ct, text) {
  if ((ct || '').includes('text/event-stream')) {
    const msgs = [];
    text.split(/\r?\n/).forEach((l) => { if (l.startsWith('data:')) { try { msgs.push(JSON.parse(l.slice(5).trim())); } catch { /* */ } } });
    return msgs;
  }
  try { return [JSON.parse(text)]; } catch { return []; }
}
async function mcp(method, params, isNotification = false) {
  const body = { jsonrpc: '2.0', method };
  if (params !== undefined) body.params = params;
  if (!isNotification) body.id = ++idCounter;
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${TOKEN}`,
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  const res = await fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify(body) });
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  const text = await res.text();
  if (!res.ok) { console.log(`HTTP ${res.status}: ${text.slice(0, 300)}`); return null; }
  if (isNotification) return null;
  const msgs = parseBody(res.headers.get('content-type'), text);
  const reply = msgs.find((m) => m.id === body.id) || msgs[0];
  if (reply?.error) { console.log('MCP error:', JSON.stringify(reply.error)); return null; }
  return reply?.result || null;
}

const QUESTION =
  'Look at this store\'s Performance Overview dashboard. Report the headline tile values '
  + 'EXACTLY as that dashboard shows them for the date range 2026-05-12 to 2026-05-18 inclusive '
  + '(its "Last 7 days" preset). Do NOT recompute from raw data or estimate — use the dashboard\'s '
  + 'own aggregated numbers. Return ONLY a compact minified JSON object, no prose, no file: '
  + '{"total_gmv":number,"affiliate_gmv":number,"orders":number,"aov":number,'
  + '"earned_media_value":number,"total_value_driven":number,"video_views":number,'
  + '"video_conversion_rate":number,"avg_daily_orders":number,"samples_shipped":number,'
  + '"videos_posted":number}. Plain numbers only — no currency symbols, no commas, no "K" suffixes '
  + '(write 5050 not "5.05K"); video_conversion_rate as a percent number (3.0 for 3.0%).';

await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wurxos-euka-probe', version: '0.1.0' } });
await mcp('notifications/initialized', undefined, true);
const stores = await mcp('tools/call', { name: 'list_accessible_stores', arguments: {} });
const raw = stores?.structuredContent ? JSON.stringify(stores.structuredContent) : (stores?.content || []).map((c) => c.text || '').join(' ');
const storeId = (raw.match(/"storeId"\s*:\s*"([^"]+)"/) || [])[1];

console.log('→ query_store_data (exact dashboard tiles, May 12-18)…');
const t0 = Date.now();
const r = await mcp('tools/call', { name: 'query_store_data', arguments: { storeId, question: QUESTION } });
console.log(`(${Math.round((Date.now() - t0) / 1000)}s)\n`);
const summary = r?.structuredContent?.summary ?? (r?.content || []).map((c) => c.text || '').join('\n');
console.log('--- raw ---'); console.log(summary); console.log('--- end ---');
const jm = summary && summary.match(/\{[\s\S]*\}/);
if (jm) {
  try {
    const got = JSON.parse(jm[0]);
    console.log('\n✓ Parsed:', JSON.stringify(got, null, 2));
    const expect = { total_gmv: 5050, affiliate_gmv: 3480, orders: 163, aov: 30.97, video_views: 461320, samples_shipped: 168, videos_posted: 262 };
    console.log('\n--- vs dashboard ---');
    for (const [k, v] of Object.entries(expect)) {
      const g = got[k];
      const pct = g != null ? `${(((g - v) / v) * 100).toFixed(1)}%` : 'n/a';
      console.log(`  ${k}: got ${g} | dash ${v} | diff ${pct}`);
    }
  } catch (e) { console.log('\n✗ parse failed:', e.message); }
} else { console.log('\n✗ No JSON found.'); }
console.log('\nDone.');
