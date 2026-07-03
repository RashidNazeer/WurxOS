// ============================================================
// TikTok Shop Academy → tts_knowledge ingestion job.
//
// For each seed URL: fetch the article server-side (no login/JS), extract the
// clean body + title + breadcrumb, chunk it, embed each chunk (OpenAI
// text-embedding-3-small), and upsert into public.tts_knowledge. Skips dead
// (404-shell) IDs and unchanged articles (content-hash), and writes a failures
// report so nothing is silently missed.
//
// Run from the project root:
//   node scripts/tts-ingest/ingest.mjs                 # ingest seed-urls.json
//   node scripts/tts-ingest/ingest.mjs --dry           # fetch+parse+chunk, NO db/embeds
//   node scripts/tts-ingest/ingest.mjs --file other.json
//
// Reads VITE_SUPABASE_URL + SERVICE_ROLL_KEY + OPEN_AI_API_KEY from .env.local.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

// ── env ─────────────────────────────────────────────────────────────
function readEnv() {
  const env = fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8');
  const get = (k) => {
    for (const line of env.split(/\r?\n/)) {
      const i = line.indexOf('=');
      if (i < 0) continue;
      if (line.slice(0, i).trim() === k) return line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
    return null;
  };
  return { url: get('VITE_SUPABASE_URL'), key: get('SERVICE_ROLL_KEY'), openai: get('OPEN_AI_API_KEY') || get('OPENAI_API_KEY') };
}

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const fileArg = (() => { const i = args.indexOf('--file'); return i >= 0 ? args[i + 1] : null; })();

const { url: SB_URL, key: SB_KEY, openai: OPENAI_KEY } = readEnv();
const sb = (SB_URL && SB_KEY) ? createClient(SB_URL, SB_KEY, { auth: { persistSession: false } }) : null;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const EMBED_MODEL = 'text-embedding-3-small';
const CHUNK_TOKENS = 700;          // target chunk size
const CHUNK_OVERLAP = 90;          // ~13% overlap
const CHARS_PER_TOKEN = 4;         // rough

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── extraction ──────────────────────────────────────────────────────
function knowledgeIdOf(url) {
  const m = url.match(/[?&](?:knowledge_id|content_id)=(\d+)/);
  return m ? m[1] : url;
}
function contentTypeOf(url) { return url.includes('/course?') ? 'course' : 'essay'; }

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}

function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<li[^>]*>/gi, '\n• ')
      .replace(/<\/(p|div|h[1-6]|tr|section|article)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  ).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// Returns { title, breadcrumb, body } or null if the page is a 404/empty shell.
function parseArticle(html) {
  if (/The content (you are looking for )?does not exist/i.test(html)) return null;

  const titleM = html.match(/<[^>]*class="[^"]*article-title[^"]*"[^>]*>([\s\S]*?)<\//i)
    || html.match(/<title>([\s\S]*?)<\/title>/i);
  const title = titleM ? decodeEntities(titleM[1].replace(/<[^>]+>/g, '')).trim() : '';

  // Body = the content-inner region up to the prev/next nav footer.
  const startM = html.match(/<div[^>]*class="[^"]*content-inner[^"]*"[^>]*>/i);
  let bodyHtml = '';
  if (startM) {
    const start = startM.index + startM[0].length;
    const navIdx = html.indexOf('knowledge-nav', start);
    bodyHtml = html.slice(start, navIdx > start ? navIdx : undefined);
  } else {
    // Fallback: whole <article> or <main>.
    const artM = html.match(/<article[\s\S]*?<\/article>/i) || html.match(/<main[\s\S]*?<\/main>/i);
    bodyHtml = artM ? artM[0] : '';
  }

  let body = htmlToText(bodyHtml);
  // First line is usually the breadcrumb ("US Academy › … ›") — split it off.
  let breadcrumb = '';
  const lines = body.split('\n');
  if (lines[0] && /›|>/.test(lines[0]) && lines[0].length < 200) {
    breadcrumb = lines[0].replace(/›/g, '>').trim();
    body = lines.slice(1).join('\n').trim();
  }
  if (!title || body.replace(/\s/g, '').length < 40) return null; // too thin → treat as miss
  return { title, breadcrumb, body };
}

// ── chunking ────────────────────────────────────────────────────────
function chunkText(text) {
  const maxChars = CHUNK_TOKENS * CHARS_PER_TOKEN;
  const overlapChars = CHUNK_OVERLAP * CHARS_PER_TOKEN;
  // Split on blank lines (paragraph-ish), then pack into ~maxChars windows.
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let buf = '';
  for (const p of paras) {
    if (buf && (buf.length + 2 + p.length) > maxChars) {
      chunks.push(buf.trim());
      // start next chunk with a tail overlap of the previous one
      buf = buf.length > overlapChars ? buf.slice(-overlapChars) + '\n\n' + p : p;
    } else {
      buf = buf ? `${buf}\n\n${p}` : p;
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  // A single very long paragraph could still exceed maxChars — hard-split those.
  const out = [];
  for (const c of chunks) {
    if (c.length <= maxChars * 1.4) { out.push(c); continue; }
    for (let i = 0; i < c.length; i += (maxChars - overlapChars)) out.push(c.slice(i, i + maxChars));
  }
  return out;
}

function sha(s) {
  // small stable hash (djb2) — enough for change detection
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

// ── embeddings ──────────────────────────────────────────────────────
async function embedBatch(texts) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });
  if (!res.ok) throw new Error(`embeddings ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return j.data.map((d) => d.embedding);
}

// ── fetch one article (with retry/backoff for transient throttling) ──
// The academy throttles bursty clients (connections get "terminated"). We
// retry transient failures with growing backoff, but treat a real HTTP 404 or
// a genuine 404-content-shell as permanent (no retry) so we don't loop on
// dead IDs. Requirement: nothing gets missed due to a transient blip.
async function fetchOnce(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en', 'Accept': 'text/html' },
      signal: ctrl.signal,
    });
    if (res.status === 404) return { permanent: true, reason: 'HTTP 404' };
    if (!res.ok) return { transient: true, reason: `HTTP ${res.status}` };
    const html = await res.text();
    const parsed = parseArticle(html);
    if (!parsed) return { permanent: true, reason: 'no-content (404 shell / empty)' };
    return { ok: true, ...parsed };
  } finally { clearTimeout(t); }
}

async function fetchArticle(url) {
  let lastReason = 'unknown';
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(1500 * attempt + Math.floor(Math.random() * 500));
    let r;
    try { r = await fetchOnce(url); }
    catch (e) { r = { transient: true, reason: (e.name === 'AbortError' ? 'timeout' : (e.message || 'fetch error')).slice(0, 100) }; }
    if (r.ok) return r;
    if (r.permanent) return { ok: false, reason: r.reason };  // dead ID — don't retry
    lastReason = r.reason; // transient — retry
  }
  return { ok: false, reason: `${lastReason} (after retries)` };
}

// ── main ────────────────────────────────────────────────────────────
async function main() {
  const seedPath = fileArg ? path.resolve(ROOT, fileArg) : path.join(__dirname, 'seed-urls.json');
  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  // dedup by knowledge_id
  const byId = new Map();
  for (const item of seed.urls || []) byId.set(knowledgeIdOf(item.url), item);
  const items = [...byId.values()];
  console.log(`Loaded ${items.length} unique URLs from ${path.basename(seedPath)}${DRY ? '  [DRY RUN]' : ''}\n`);

  if (!DRY && (!sb || !OPENAI_KEY)) { console.error('Missing SUPABASE or OPENAI creds in .env.local'); process.exit(1); }

  const failures = [];
  let okCount = 0, chunkCount = 0, skipped = 0;

  for (const item of items) {
    const url = item.url;
    const kid = knowledgeIdOf(url);
    process.stdout.write(`• ${kid}  `);
    let art;
    try { art = await fetchArticle(url); }
    catch (e) { art = { ok: false, reason: e.message?.slice(0, 120) || 'fetch error' }; }

    if (!art.ok) {
      console.log(`SKIP (${art.reason})`);
      failures.push({ url, knowledge_id: kid, reason: art.reason });
      await sleep(1200);
      continue;
    }

    const hash = sha(`${art.title}\n${art.body}`);
    // change-detection: skip if this article's hash is already stored
    if (!DRY) {
      const { data: existing } = await sb.from('tts_knowledge')
        .select('content_hash').eq('knowledge_id', kid).eq('chunk_index', 0).maybeSingle();
      if (existing?.content_hash === hash) {
        console.log(`unchanged, skip  "${art.title.slice(0, 50)}"`);
        skipped++;
        await sleep(1200);
        continue;
      }
    }

    const chunks = chunkText(art.body);
    // Prepend breadcrumb + title into each chunk BEFORE embedding so short
    // chunks keep their context (critical for recall on policy snippets).
    const embedInputs = chunks.map((c) =>
      `${art.breadcrumb ? art.breadcrumb + '\n' : ''}${art.title}\n\n${c}`);

    console.log(`OK  "${art.title.slice(0, 50)}"  → ${chunks.length} chunks`);
    okCount++; chunkCount += chunks.length;

    if (DRY) { await sleep(1200); continue; }

    // embed (batch) then upsert rows; refresh = delete old chunks for this id first
    let embeddings;
    try { embeddings = await embedBatch(embedInputs); }
    catch (e) { console.log(`   embed failed: ${e.message}`); failures.push({ url, knowledge_id: kid, reason: 'embed: ' + e.message }); continue; }

    await sb.from('tts_knowledge').delete().eq('knowledge_id', kid);
    const rows = chunks.map((c, i) => ({
      knowledge_id: kid,
      chunk_index: i,
      source_url: url,
      breadcrumb: art.breadcrumb || null,
      title: art.title,
      content_type: contentTypeOf(url),
      category: item.category || null,
      chunk_text: c,
      embedding: embeddings[i],
      content_hash: hash,
      token_estimate: Math.round(c.length / CHARS_PER_TOKEN),
      is_active: true,
      updated_at: new Date().toISOString(),
    }));
    const { error } = await sb.from('tts_knowledge').insert(rows);
    if (error) { console.log(`   insert failed: ${error.message}`); failures.push({ url, knowledge_id: kid, reason: 'db: ' + error.message }); }
    await sleep(1200); // gentle
  }

  // failures report
  const reportPath = path.join(__dirname, 'failures.json');
  fs.writeFileSync(reportPath, JSON.stringify({ generated_at: new Date().toISOString(), count: failures.length, failures }, null, 2));

  console.log('\n──────────────────────────────────────────');
  console.log(`Ingested: ${okCount} articles, ${chunkCount} chunks`);
  console.log(`Unchanged (skipped): ${skipped}`);
  console.log(`Failed/unreachable: ${failures.length}  → scripts/tts-ingest/failures.json`);
  if (failures.length) {
    console.log('\nURLs that could NOT be fetched (give these to me to add manually):');
    for (const f of failures) console.log(`  - ${f.url}  (${f.reason})`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
