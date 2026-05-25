// Euka MCP probe #6 — comprehensive query_store_data, then resolve
// its sandbox-file artifact via read_sandbox_file. Confirms the
// full flow the euka-sync function must implement.
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
  'Compute a metrics object and SAVE IT to a sandbox file as pure JSON. Exact shape: '
  + '{"d7":{...},"d30":{...},"top":{"creator_name":string,"creator_gmv":number,'
  + '"product_name":string,"product_gmv":number}}. d7 = last 7 days, d30 = last 30 days; each '
  + 'has numeric keys (plain numbers, no symbols/commas, null if unavailable): gmv, video_gmv, '
  + 'units, orders, aov, active_creators, videos_posted, video_views, ad_spend, roas, '
  + 'sample_requests, outreach_messages, collab_invites. The saved file must contain ONLY the '
  + 'JSON object, nothing else.';

await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wurxos-euka-probe', version: '0.1.0' } });
await mcp('notifications/initialized', undefined, true);
const stores = await mcp('tools/call', { name: 'list_accessible_stores', arguments: {} });
const raw = stores?.structuredContent ? JSON.stringify(stores.structuredContent) : (stores?.content || []).map((c) => c.text || '').join(' ');
const storeId = (raw.match(/"storeId"\s*:\s*"([^"]+)"/) || [])[1];

console.log('→ query_store_data…');
const t0 = Date.now();
const r = await mcp('tools/call', { name: 'query_store_data', arguments: { storeId, question: QUESTION } });
console.log(`(${Math.round((Date.now() - t0) / 1000)}s)\n`);
console.log('--- structuredContent ---');
console.log(JSON.stringify(r?.structuredContent, null, 2)?.slice(0, 2000));

// Resolve a sandbox file path: from artifacts, else regex the summary.
const sc = r?.structuredContent || {};
const summary = sc.summary || (r?.content || []).map((c) => c.text || '').join('\n');
let path = null;
if (Array.isArray(sc.artifacts) && sc.artifacts.length) {
  const a = sc.artifacts[0];
  path = typeof a === 'string' ? a : (a.path || a.file || a.name || null);
}
if (!path) { const m = summary.match(/(exports\/[\w./-]+\.json)/); if (m) path = m[1]; }
console.log('\nresolved sandbox path:', path);

if (path) {
  console.log('\n→ read_sandbox_file…');
  const f = await mcp('tools/call', { name: 'read_sandbox_file', arguments: { path } });
  const ftext = f?.structuredContent ? JSON.stringify(f.structuredContent) : (f?.content || []).map((c) => c.text || '').join('\n');
  console.log('--- file content ---'); console.log(ftext.slice(0, 2500)); console.log('--- end ---');
  const jm = ftext.match(/\{[\s\S]*\}/);
  if (jm) { try { console.log('\n✓ Parsed metrics:', JSON.stringify(JSON.parse(jm[0]), null, 2)); } catch (e) { console.log('\n✗ parse failed:', e.message); } }
}
console.log('\nDone.');
