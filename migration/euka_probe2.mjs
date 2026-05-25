// Euka MCP probe #2 — call the read-only data tools to see real
// output shape: list_accessible_stores, then one query_store_data.
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
    text.split(/\r?\n/).forEach((l) => {
      if (l.startsWith('data:')) { try { msgs.push(JSON.parse(l.slice(5).trim())); } catch { /* */ } }
    });
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
  if (!res.ok) { console.log(`  HTTP ${res.status} for ${method}: ${text.slice(0, 400)}`); return null; }
  if (isNotification) return null;
  const msgs = parseBody(res.headers.get('content-type'), text);
  const reply = msgs.find((m) => m.id === body.id) || msgs[0];
  if (!reply) { console.log(`  no reply for ${method}: ${text.slice(0, 300)}`); return null; }
  if (reply.error) { console.log(`  MCP error for ${method}:`, JSON.stringify(reply.error)); return null; }
  return reply.result;
}

function showResult(label, result) {
  console.log(`\n=== ${label} ===`);
  if (!result) { console.log('(null)'); return; }
  // MCP tool results: { content: [{type, text|...}], structuredContent?, isError? }
  if (result.structuredContent) {
    console.log('structuredContent:', JSON.stringify(result.structuredContent, null, 2).slice(0, 2500));
  }
  if (Array.isArray(result.content)) {
    result.content.forEach((c, i) => {
      if (c.type === 'text') console.log(`content[${i}] text:`, c.text.slice(0, 2500));
      else console.log(`content[${i}] (${c.type}):`, JSON.stringify(c).slice(0, 600));
    });
  }
  if (result.isError) console.log('(isError: true)');
}

// ── Handshake ────────────────────────────────────────────────────
await mcp('initialize', {
  protocolVersion: '2025-06-18', capabilities: {},
  clientInfo: { name: 'wurxos-euka-probe', version: '0.1.0' },
});
await mcp('notifications/initialized', undefined, true);

// ── list_accessible_stores ───────────────────────────────────────
console.log('→ tools/call list_accessible_stores');
const stores = await mcp('tools/call', { name: 'list_accessible_stores', arguments: {} });
showResult('list_accessible_stores', stores);

// Pull a storeId out of the result text/structured for the next call.
let storeId = null;
try {
  const raw = stores?.structuredContent
    ? JSON.stringify(stores.structuredContent)
    : (stores?.content || []).map((c) => c.text || '').join(' ');
  const m = raw.match(/"storeId"\s*:\s*"([^"]+)"/) || raw.match(/"id"\s*:\s*"([0-9a-f-]{20,})"/i);
  if (m) storeId = m[1];
} catch { /* */ }
console.log(`\nstoreId picked for analytics test: ${storeId || '(none found)'}`);

// ── query_store_data — see the analytics output shape ────────────
if (storeId) {
  console.log('\n→ tools/call query_store_data (this may take a while)…');
  const analytics = await mcp('tools/call', {
    name: 'query_store_data',
    arguments: {
      storeId,
      question: 'What is the total GMV, total orders, and units sold for the last 7 days? Give the numbers.',
    },
  });
  showResult('query_store_data', analytics);
}
console.log('\nDone.');
