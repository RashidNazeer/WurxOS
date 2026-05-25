// Euka MCP probe #3 — ask query_store_data for strict JSON output,
// to confirm we can parse metrics reliably for the sync.
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

await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wurxos-euka-probe', version: '0.1.0' } });
await mcp('notifications/initialized', undefined, true);

const stores = await mcp('tools/call', { name: 'list_accessible_stores', arguments: {} });
const raw = stores?.structuredContent ? JSON.stringify(stores.structuredContent) : (stores?.content || []).map((c) => c.text || '').join(' ');
const storeId = (raw.match(/"storeId"\s*:\s*"([^"]+)"/) || [])[1];
console.log('storeId:', storeId);

const QUESTION = 'Return ONLY a compact minified JSON object and nothing else — no prose, no explanation, no markdown code fences. '
  + 'Use exactly these keys with plain numeric values (no currency symbols, no commas, no quotes around numbers): '
  + 'gmv_7d, units_7d, orders_7d, gmv_30d, units_30d, orders_30d. '
  + 'gmv = total GMV in USD across all channels; units = total units sold; orders = total orders. '
  + 'gmv_7d/units_7d/orders_7d cover the last 7 days; gmv_30d/units_30d/orders_30d cover the last 30 days.';

console.log('\n→ query_store_data (JSON-output test)…');
const t0 = Date.now();
const r = await mcp('tools/call', { name: 'query_store_data', arguments: { storeId, question: QUESTION } });
console.log(`(took ${Math.round((Date.now() - t0) / 1000)}s)\n`);

const summary = r?.structuredContent?.summary
  ?? (r?.content || []).map((c) => c.text || '').join('\n');
console.log('--- raw summary ---');
console.log(summary);
console.log('--- end ---');

// Try to extract a JSON object from it.
const jm = summary && summary.match(/\{[\s\S]*\}/);
if (jm) {
  try {
    const parsed = JSON.parse(jm[0]);
    console.log('\n✓ Parsed JSON:', JSON.stringify(parsed));
  } catch (e) {
    console.log('\n✗ Found a {...} block but JSON.parse failed:', e.message);
  }
} else {
  console.log('\n✗ No JSON object found in the response.');
}
