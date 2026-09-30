// Data-tool contracts (A§11). Pure types; the DB client is injected.

// userClient: supabase client carrying the CALLER'S OWN JWT (anon key +
// `Authorization: Bearer <access token>`), required for every non-Boss caller
// so the table RLS decides what they see. The Boss (and the Boss-only Slack
// relay) runs on the service client instead.
export type ToolCtx = { userId: string; role: string; userClient?: Db };

// Where a result came from, for [D#] citations. ids are capped (SOURCE_ID_CAP).
export type ToolSource = {
  table: string;
  ids?: string[];
  period?: string | null;
  status?: string | null;
  brand?: string | null;
  currency?: string | null;
  pending?: { id: string; period: string; status: string; brand?: string }[];
  extra?: Record<string, unknown>;
};

export type ToolResult = {
  name: string;
  text: string;
  source: ToolSource;
  truncated: boolean;
  data?: unknown;   // structured extras for the agent/tests (e.g. get_top_creators rows)
};

// JSON-schema tool definition in the provider-neutral shape; the LLM adapter
// (WP-D) wraps it for Responses / Chat Completions.
export type ToolDef = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

// supabase-js client (service role). Typed loosely on purpose: the same code
// runs against esm.sh's client in Deno and npm's in Node.
// deno-lint-ignore no-explicit-any
export type Db = any;
