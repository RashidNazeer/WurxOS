// ============================================================
// db-backup — the weekly database backup (mig 410).
//
//   POST {mode:'continue'} (or no body) from backup_tick() every minute while a
//                          run is unfinished: one resumable slice (~100 s).
//   POST {mode:'start'}    open a run (backup_start: disabled / already_running
//                          / too_soon are returned as they are), then a slice.
//
// Deploy with --no-verify-jwt: the caller proves itself with the
// x-webhook-secret header (the same AI_INGEST_SECRET as ai-ingest / tts-crawl).
// Writes only the private `db-backups` bucket and backup_runs. The logic is in
// _shared/backup/run.ts, which the Node tests run too.
//
// Secrets: AI_INGEST_SECRET; SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are built in.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { supabaseRpc } from '../_shared/ai/ingest/db.ts';
import { runBackup, type BackupStorage } from '../_shared/backup/run.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const INGEST_SECRET = Deno.env.get('AI_INGEST_SECRET') ?? '';
const BUCKET = 'db-backups';

// Constant-time, so response timing does not leak how much of a guess matched.
function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// deno-lint-ignore no-explicit-any
export function bucketStorage(admin: any, bucket = BUCKET): BackupStorage {
  const files = admin.storage.from(bucket);
  return {
    async upload(path, body, contentType) {
      const { error } = await files.upload(path, body, { contentType, upsert: true });
      if (error) throw new Error(`upload ${path}: ${error.message}`);
    },
    async list(prefix) {
      const { data, error } = await files.list(prefix, { limit: 1000 });
      if (error) throw new Error(`list ${prefix}: ${error.message}`);
      return (data ?? []).map((f: { name: string }) => f.name);
    },
    async remove(paths) {
      if (!paths.length) return;
      const { error } = await files.remove(paths);
      if (error) throw new Error(`remove: ${error.message}`);
    },
  };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!INGEST_SECRET || !sameSecret(req.headers.get('x-webhook-secret') ?? '', INGEST_SECRET)) {
    return new Response('Unauthorized', { status: 401 });
  }
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: 'function secrets missing' }, 500);

  const text = await req.text();
  let body: { mode?: unknown } | null = null;
  try { body = text.trim() ? JSON.parse(text) : null; } catch { return json({ error: 'body is not JSON' }, 400); }
  const mode = body?.mode ?? 'continue';
  if (mode !== 'continue' && mode !== 'start') return json({ error: "mode must be 'continue' or 'start'" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const rpc = supabaseRpc(admin);
  try {
    const started = mode === 'start' ? await rpc('backup_start', { p_trigger: 'api' }) : undefined;
    const result = await runBackup({ rpc, storage: bucketStorage(admin), workerId: `db-backup-${crypto.randomUUID()}` });
    return json({ ok: true, started, ...result });
  } catch (e) {
    console.error('db-backup:', String((e as Error)?.message ?? e).slice(0, 500));
    return json({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 500) }, 500);
  }
});
