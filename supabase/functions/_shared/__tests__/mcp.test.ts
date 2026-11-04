// The Claude connector: JSON-RPC handling and access rules. Pure, no database, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleBody, handleMessage, SUPPORTED_VERSIONS, type McpDeps } from '../mcp/protocol.ts';
import { MCP_CALLS_PER_MINUTE, MCP_ROLES, mcpAllowed, rateLimited, sourceLine } from '../mcp/access.ts';
import { TOOL_DEFS } from '../ai/tools/index.ts';

const calls: Array<[string, unknown]> = [];
const deps: McpDeps = {
  serverName: 'wurxos',
  serverVersion: '1',
  tools: () => [{ name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: {} } }, { name: 'boom', description: 'x', inputSchema: { type: 'object' } }],
  callTool: async (name, args) => {
    calls.push([name, args]);
    if (name === 'boom') throw new Error('secret internals');
    return { text: `hi ${JSON.stringify(args)}` };
  },
};
const rpc = (method: string, params?: unknown, id: number | null = 1) => ({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, ...(params ? { params } : {}) });

test('initialize: echoes a supported protocol version, falls back to the newest otherwise', async () => {
  const a: any = await handleMessage(rpc('initialize', { protocolVersion: '2025-03-26' }), deps);
  assert.equal(a.result.protocolVersion, '2025-03-26');
  assert.equal(a.result.serverInfo.name, 'wurxos');
  assert.ok(a.result.capabilities.tools);
  const b: any = await handleMessage(rpc('initialize', { protocolVersion: '1999-01-01' }), deps);
  assert.equal(b.result.protocolVersion, SUPPORTED_VERSIONS[0]);
});

test('tools/list: every tool is marked read-only', async () => {
  const r: any = await handleMessage(rpc('tools/list'), deps);
  assert.equal(r.result.tools.length, 2);
  for (const t of r.result.tools) assert.equal(t.annotations.readOnlyHint, true);
});

test('tools/call: runs the tool and wraps the text; unknown tool and bad arguments are protocol errors', async () => {
  const ok: any = await handleMessage(rpc('tools/call', { name: 'echo', arguments: { a: 1 } }), deps);
  assert.deepEqual(ok.result.content, [{ type: 'text', text: 'hi {"a":1}' }]);
  assert.equal(ok.result.isError, undefined);
  const unknown: any = await handleMessage(rpc('tools/call', { name: 'nope' }), deps);
  assert.equal(unknown.error.code, -32602);
  const bad: any = await handleMessage(rpc('tools/call', { name: 'echo', arguments: [1] }), deps);
  assert.equal(bad.error.code, -32602);
});

test('a throwing tool becomes an isError result that does not leak the exception message', async () => {
  const r: any = await handleMessage(rpc('tools/call', { name: 'boom', arguments: {} }), deps);
  assert.equal(r.result.isError, true);
  assert.ok(!JSON.stringify(r).includes('secret internals'));
});

test('notifications get no response; unknown methods with an id get -32601; junk is -32600', async () => {
  assert.equal(await handleMessage(rpc('notifications/initialized', undefined, null), deps), null);
  const m: any = await handleMessage(rpc('resources/list'), deps);
  assert.equal(m.error.code, -32601);
  const j: any = await handleMessage({ foo: 1 } as any, deps);
  assert.equal(j.error.code, -32600);
  const p: any = await handleMessage(rpc('ping'), deps);
  assert.deepEqual(p.result, {});
});

test('batches: answers for requests only; a batch of notifications is null', async () => {
  const r: any = await handleBody([rpc('ping', undefined, 1), rpc('notifications/initialized', undefined, null), rpc('ping', undefined, 2)], deps);
  assert.equal(r.length, 2);
  assert.equal(await handleBody([rpc('notifications/initialized', undefined, null)], deps), null);
  const empty: any = await handleBody([], deps);
  assert.equal(empty.error.code, -32600);
});

test('access: Boss and OL only; 30 calls a minute; an unreadable count fails open', () => {
  assert.deepEqual([...MCP_ROLES].sort(), ['boss', 'ol']);
  for (const r of ['developer', 'tl', 'pctl', 'apc', 'ipc', 'ads_manager', '', 'BOSS']) assert.ok(!MCP_ROLES.includes(r), r);
  assert.equal(rateLimited(MCP_CALLS_PER_MINUTE - 1), false);
  assert.equal(rateLimited(MCP_CALLS_PER_MINUTE), true);
  assert.equal(rateLimited(null), false);
  assert.equal(rateLimited(undefined), false);
});

test('mcpAllowed: exact Boss/OL on an active account, nothing else gets in', () => {
  const on = { is_active: true, deleted_at: null };
  assert.equal(mcpAllowed({ role: 'boss', ...on }), true);
  assert.equal(mcpAllowed({ role: 'ol', ...on }), true);
  for (const role of ['apc', 'ipc', 'tl', 'pctl', 'developer', 'ads_manager', 'OL', 'Boss', ' ol', 'ol ', 'ol\n', 'o l', '', 'admin', 'service_role', '__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    assert.equal(mcpAllowed({ role, ...on }), false, JSON.stringify(role));
  }
  for (const role of [null, undefined, 1, true, ['ol'], { toString: () => 'ol' }]) assert.equal(mcpAllowed({ role, ...on }), false, String(role));
  assert.equal(mcpAllowed({ role: 'ol', is_active: false, deleted_at: null }), false);
  assert.equal(mcpAllowed({ role: 'ol', is_active: null, deleted_at: null }), false);
  assert.equal(mcpAllowed({ role: 'ol', is_active: undefined, deleted_at: null }), false);
  assert.equal(mcpAllowed({ role: 'boss', is_active: true, deleted_at: '2026-10-12T00:00:00Z' }), false);
  assert.equal(mcpAllowed(null), false);
  assert.equal(mcpAllowed(undefined), false);
});

test('sourceLine: empty for no source, otherwise the table, brand and period', () => {
  assert.equal(sourceLine({ table: 'none' }), '');
  assert.equal(sourceLine({ table: 'reports', brand: 'Cutler', period: '2026-10' }), '\n\nSource: reports · Cutler · 2026-10');
});

test('the connector exposes Wurx Buddy\'s data tools, each with a JSON-schema object', () => {
  assert.ok(TOOL_DEFS.length >= 14);
  for (const t of TOOL_DEFS) {
    assert.equal((t.parameters as any).type, 'object', t.name);
    assert.ok(t.description.length > 20, t.name);
  }
  for (const n of ['get_performance', 'get_reports', 'rank_brands', 'get_salary']) assert.ok(TOOL_DEFS.some((t) => t.name === n), n);
});
