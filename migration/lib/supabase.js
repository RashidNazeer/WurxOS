import { createClient } from '@supabase/supabase-js';
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '..', '..', '.env.local') });

const url = process.env.VITE_SUPABASE_URL;
const serviceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SERVICE_ROLE_KEY ||
  process.env.SERVICE_ROLL_KEY;

if (!url || !serviceKey) {
  throw new Error(
    'Missing Supabase env. Need VITE_SUPABASE_URL and SERVICE_ROLL_KEY in .env.local',
  );
}

export const sb = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

export const sbUrl = url;
