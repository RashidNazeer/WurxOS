// Discovery probe for the Euka MCP server.
// Reads EUKA_TOKEN from .env.local, does the MCP handshake over the
// Streamable-HTTP transport, and prints every tool it exposes so we
// can design the euka_shop_metrics table + sync function.
import fs from 'fs';

const MCP_URL = 'https://app.euka.ai/api/mcp';

// ── Load EUKA_TOKEN from .env.local ──────────────────────────────
const envPath = new URL('../.env.local', import.meta.url);
const env = {};
fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach((line) => {
  const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
});
const TOKEN = env.EUKA_TOKEN;
if (!TOKEN) { console.log('ERR: EUKA_TOKEN not found in .env.local'); process.exit(1); }
console.log(`Token loaded (${TOKEN.slice(0, 6)}…${TOKEN.slice(-4)}, ${TOKEN.length} chars)\n`);

let sessionId = null;
let idCounter = 0;

function parseBody(ct, text) {
  if ((ct || '').includes('text/event-stream')) {
    const msgs = [];
    text.split(/\r?\n/).forEach((l) => {
      if (l.startsWith('data:')) {
        try { msgs.push(JSON.parse(l.slice(5).trim())); } catch { /* ignore */ }
      }
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
  if (!res.ok) {
    console.log(`  HTTP ${res.status} for ${method}: ${text.slice(0, 400)}`);
    return null;
  }
  if (isNotification) return null;
  const msgs = parseBody(res.headers.get('content-type'), text);
  const reply = msgs.find((m) => m.id === body.id) || msgs[0];
  if (!reply) { console.log(`  No parseable reply for ${method}: ${text.slice(0, 300)}`); return null; }
  if (reply.error) { console.log(`  MCP error for ${method}:`, JSON.stringify(reply.error)); return null; }
  return reply.result;
}

// ── Handshake ────────────────────────────────────────────────────
console.log('→ initialize');
const init = await mcp('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'wurxos-euka-probe', version: '0.1.0' },
});
if (!init) { console.log('initialize failed — stopping.'); process.exit(1); }
console.log('  server:', JSON.stringify(init.serverInfo || {}), '| session:', sessionId || '(none)');

await mcp('notifications/initialized', undefined, true);

// ── tools/list ───────────────────────────────────────────────────
console.log('\n→ tools/list');
const tools = await mcp('tools/list', {});
if (!tools) { console.log('tools/list failed — stopping.'); process.exit(1); }

const list = tools.tools || [];
console.log(`\n${list.length} tool(s) exposed by Euka:\n`);
for (const t of list) {
  console.log(`● ${t.name}`);
  if (t.description) console.log(`   ${t.description.replace(/\s+/g, ' ').trim()}`);
  if (t.inputSchema) {
    const props = t.inputSchema.properties || {};
    const keys = Object.keys(props);
    if (keys.length) {
      console.log(`   params: ${keys.map((k) => `${k}${(t.inputSchema.required || []).includes(k) ? '*' : ''}`).join(', ')}`);
    } else {
      console.log('   params: (none)');
    }
  }
  console.log('');
}
console.log('Done. (* = required param)');
