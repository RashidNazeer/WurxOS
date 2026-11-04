// Model Context Protocol over HTTP (JSON-RPC 2.0, "Streamable HTTP" without SSE): just enough for
// Claude's custom connectors to list and call tools. Pure: the caller, the tool list and the tool
// runner are injected, so this file knows nothing about Supabase.

export const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

export type McpTool = { name: string; description: string; inputSchema: Record<string, unknown> };
export type McpToolOutput = { text: string; isError?: boolean };

export type McpDeps = {
  serverName: string;
  serverVersion: string;
  tools: () => McpTool[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<McpToolOutput>;
};

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: any };
export type RpcResponse = { jsonrpc: '2.0'; id: string | number | null; result?: unknown; error?: { code: number; message: string } };

const ok = (id: Rpc['id'], result: unknown): RpcResponse => ({ jsonrpc: '2.0', id: id ?? null, result });
const fail = (id: Rpc['id'], code: number, message: string): RpcResponse => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

// Every tool here only reads; tell the client so it can skip confirmation prompts.
const annotate = (t: McpTool) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } });

// One JSON-RPC message → its response, or null for a notification (the HTTP layer answers 202).
export async function handleMessage(msg: Rpc, deps: McpDeps): Promise<RpcResponse | null> {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(msg?.id, -32600, 'Invalid request');
  const isNotification = msg.id === undefined || msg.id === null;
  switch (msg.method) {
    case 'initialize': {
      const asked = String(msg.params?.protocolVersion ?? '');
      const version = (SUPPORTED_VERSIONS as readonly string[]).includes(asked) ? asked : SUPPORTED_VERSIONS[0];
      return ok(msg.id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: deps.serverName, version: deps.serverVersion },
        instructions: 'WurxOS data, read-only. Every answer respects the signed-in person\'s own access; quote figures exactly as returned and say when a result is truncated or missing.',
      });
    }
    case 'ping': return ok(msg.id, {});
    case 'tools/list': return ok(msg.id, { tools: deps.tools().map(annotate) });
    case 'tools/call': {
      const name = String(msg.params?.name ?? '');
      const args = msg.params?.arguments;
      if (!deps.tools().some((t) => t.name === name)) return fail(msg.id, -32602, `Unknown tool: ${name}`);
      if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) return fail(msg.id, -32602, 'arguments must be an object');
      try {
        const r = await deps.callTool(name, (args ?? {}) as Record<string, unknown>);
        return ok(msg.id, { content: [{ type: 'text', text: r.text }], ...(r.isError ? { isError: true } : {}) });
      } catch {
        // A failing tool is reported to the model as a result, not as a protocol error.
        return ok(msg.id, { content: [{ type: 'text', text: `Tool ${name} failed. Try again in a moment.` }], isError: true });
      }
    }
    default:
      if (isNotification) return null;             // notifications/initialized, notifications/cancelled, …
      return fail(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

// The HTTP body: one message or a batch. Returns null when nothing needs an answer.
export async function handleBody(body: unknown, deps: McpDeps): Promise<RpcResponse | RpcResponse[] | null> {
  if (Array.isArray(body)) {
    if (!body.length) return fail(null, -32600, 'Empty batch');
    const out = (await Promise.all(body.map((m) => handleMessage(m, deps)))).filter((r): r is RpcResponse => r !== null);
    return out.length ? out : null;
  }
  return handleMessage(body as Rpc, deps);
}
