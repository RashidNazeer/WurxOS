// Euka MCP probe #7 — dump the full tools/list with descriptions
// and input schemas, to find a tool that returns the exact
// dashboard metrics (instead of the LLM-approximated query_store_data).
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

const list = await mcp('tools/list', {});
const tools = list?.tools || [];
console.log(`=== ${tools.length} tools ===\n`);
for (const t of tools) {
  console.log(`• ${t.name}`);
  console.log(`  ${(t.description || '').replace(/\s+/g, ' ').slice(0, 220)}`);
  const props = t.inputSchema?.properties ? Object.keys(t.inputSchema.properties) : [];
  if (props.length) console.log(`  args: ${props.join(', ')}`);
  console.log('');
}
console.log('Done.');
