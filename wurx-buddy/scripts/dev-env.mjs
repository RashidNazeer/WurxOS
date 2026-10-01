// Shared by every dev script: reads ../.env.dev and returns the dev database
// URL, or exits. The guard parses the URL and checks WHERE it connects (host
// and pooler user), not whether the ref appears somewhere in the string.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ASSISTANT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ROOT = path.resolve(ASSISTANT, '..');   // app repo root, where .env.dev lives
const PROD_REF = 'xoaaidgvblondjpvxjqp';

export function readEnv() {
  return Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env.dev'), 'utf8').split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
}

// Returns null when the URL targets the dev project, else the reason to refuse.
export function checkDevUrl(raw, devRef) {
  if (!devRef || !/^[a-z0-9]{20}$/.test(devRef)) return 'WURXOS_DEV_PROJECT_REF is missing or malformed';
  if (devRef === PROD_REF) return 'WURXOS_DEV_PROJECT_REF is the PRODUCTION project';
  let u;
  try { u = new URL(raw); } catch { return 'WURXOS_DEV_DB_URL is not a URL'; }
  if (!/^postgres(ql)?:$/.test(u.protocol)) return 'WURXOS_DEV_DB_URL is not a postgres:// URL';
  const host = u.hostname.toLowerCase();
  const user = decodeURIComponent(u.username);
  // pg lets query parameters override host/user; an empty host falls back to PGHOST.
  if (!host) return 'WURXOS_DEV_DB_URL has no host';
  if (['host', 'hostaddr', 'user', 'options'].some((k) => u.searchParams.has(k))) return 'WURXOS_DEV_DB_URL overrides host/user in its query string';
  if (host.includes(PROD_REF) || user.includes(PROD_REF)) return 'WURXOS_DEV_DB_URL is the PRODUCTION project';
  const direct = host === `db.${devRef}.supabase.co`;
  const pooler = /^[a-z0-9-]+\.pooler\.supabase\.com$/.test(host) && user === `postgres.${devRef}`;
  return direct || pooler ? null : 'WURXOS_DEV_DB_URL does not connect to WURXOS_DEV_PROJECT_REF';
}

export function devDbUrl() {
  const env = readEnv();
  const url = env.WURXOS_DEV_DB_URL || '';
  const why = checkDevUrl(url, env.WURXOS_DEV_PROJECT_REF || '');
  if (why) { console.error(`Refusing: ${why}.`); process.exit(1); }
  return url;
}

export const stripBom = (s) => s.replace(/^﻿/, '');

// Top-level transaction-control statements in a SQL file (comments, quoted
// strings and $$-bodies ignored). The `sql` runner refuses any: one `commit`
// would make everything after it permanent while it still says "rolled back".
export function findTxControl(sql) {
  const code = stripBom(sql)
    .replace(/(\$[A-Za-z_]*\$)[\s\S]*?\1/g, ' ')
    .replace(/'(?:[^']|'')*'/g, ' ')
    .replace(/"(?:[^"]|"")*"/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
  return code.split(';').map((s) => s.trim().replace(/\s+/g, ' '))
    .filter((s) => /^(begin|commit|end|abort|rollback|start transaction|prepare transaction)\b/i.test(s)
                && !/^rollback( transaction| work)? to\b/i.test(s));
}

// Dev helper: the Supabase pooler presents a cert chain Node doesn't trust by default.
export const SSL = { rejectUnauthorized: false };
