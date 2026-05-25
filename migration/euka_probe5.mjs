// Euka MCP probe #5 — confirm the comprehensive JSON metrics pull
// (the exact question the euka-sync function will use) and its timing.
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
  'Return ONLY a compact minified JSON object and nothing else — no prose, no explanation, no '
  + 'markdown code fences. Exact shape: {"d7":{...},"d30":{...},"top":{"creator_name":string,'
  + '"creator_gmv":number,"product_name":string,"product_gmv":number}}. d7 covers the last 7 days, '
  + 'd30 the last 30 days; each is an object with these numeric keys (plain numbers — no currency '
  + 'symbols, no commas, no quotes around numbers; use null when a metric is unavailable): '
  + 'gmv, video_gmv, units, orders, aov, active_creators, videos_posted, video_views, ad_spend, '
  + 'roas, sample_requests, outreach_messages, collab_invites. gmv = total GMV (USD) all channels; '
  + 'video_gmv = GMV from creator videos; aov = average order value; ad_spend = GMV Max ad spend; '
  + 'roas = GMV Max return on ad spend. "top" is the single best creator and best product over the '
  + 'last 30 days.';

await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wurxos-euka-probe', version: '0.1.0' } });
await mcp('notifications/initialized', undefined, true);
const stores = await mcp('tools/call', { name: 'list_accessible_stores', arguments: {} });
const raw = stores?.structuredContent ? JSON.stringify(stores.structuredContent) : (stores?.content || []).map((c) => c.text || '').join(' ');
const storeId = (raw.match(/"storeId"\s*:\s*"([^"]+)"/) || [])[1];

console.log('→ query_store_data (comprehensive JSON)…');
const t0 = Date.now();
const r = await mcp('tools/call', { name: 'query_store_data', arguments: { storeId, question: QUESTION } });
console.log(`(took ${Math.round((Date.now() - t0) / 1000)}s)\n`);
const summary = r?.structuredContent?.summary ?? (r?.content || []).map((c) => c.text || '').join('\n');
console.log('--- raw ---'); console.log(summary); console.log('--- end ---');
const jm = summary && summary.match(/\{[\s\S]*\}/);
if (jm) {
  try { console.log('\n✓ Parsed:', JSON.stringify(JSON.parse(jm[0]), null, 2)); }
  catch (e) { console.log('\n✗ JSON.parse failed:', e.message); }
} else { console.log('\n✗ No JSON found.'); }
console.log('\nDone.');
