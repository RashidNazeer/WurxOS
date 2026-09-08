// ============================================================
// Edge Function: slack-events
//
// Someone tags a watched person in a Slack channel with a question. We answer
// it with the WurxOS assistant (real data, real tools) and post the answer into
// ONE internal channel where the OLs and the Boss can read it and forward it on.
//
//   #pure-daily-care:  "@Haider what was our GMV last 7 days?"
//        ↓ (this function)
//   #top-management:   the question, who asked, and the answer
//
// ── WHY THE ANSWER NEVER GOES BACK TO THE SOURCE CHANNEL ───────────────────
// The assistant can reach salary, performance, incentives and attendance. In
// the app those are gated by the caller's login. A Slack user has no WurxOS
// login, so the safety comes from WHERE the answer lands, not from who asked.
// One fixed internal destination whose members already have full access is the
// whole security model — so the destination is config, never derived from the
// incoming event.
//
// ── THINGS SLACK MAKES YOU GET RIGHT ───────────────────────────────────────
//  1. SIGNATURE. Every request is HMAC-signed. Verified here against the raw
//     body, with a 5-minute freshness window, so a replayed or forged request
//     is rejected. Without this the URL is a public "make the bot say things"
//     endpoint.
//  2. THREE SECONDS. Slack retries anything slower. The assistant takes far
//     longer, so we ACK immediately and do the work after responding.
//  3. RETRIES. Slack redelivers on any doubt. event_id is stored unique, so a
//     redelivery is a no-op instead of a second identical post.
//  4. LOOPS. The bot must ignore its own messages, or one answer in a watched
//     channel becomes an infinite conversation with itself.
//
// Env (supabase secrets): SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN,
//   AI_INTERNAL_SECRET (shared with ai-chat), SUPABASE_URL/SERVICE_ROLE_KEY.
// Deploy: supabase functions deploy slack-events --no-verify-jwt
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SIGNING_SECRET = Deno.env.get('SLACK_SIGNING_SECRET') ?? '';
const BOT_TOKEN = Deno.env.get('SLACK_BOT_TOKEN') ?? '';
const AI_INTERNAL_SECRET = Deno.env.get('AI_INTERNAL_SECRET') ?? '';

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

// ── Slack request signing ───────────────────────────────────────────────────
// v0=HMAC_SHA256(signing_secret, "v0:" + timestamp + ":" + rawBody)
async function verifySlack(req: Request, raw: string): Promise<string | null> {
  if (!SIGNING_SECRET) return 'SLACK_SIGNING_SECRET not configured';
  const ts = req.headers.get('x-slack-request-timestamp') || '';
  const sig = req.headers.get('x-slack-signature') || '';
  if (!ts || !sig) return 'missing signature headers';

  // Reject anything old enough to be a replay.
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return 'stale timestamp';

  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(SIGNING_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`v0:${ts}:${raw}`));
  const mine = 'v0=' + Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, '0')).join('');

  // Constant-time-ish compare: same length, XOR every byte.
  if (mine.length !== sig.length) return 'signature mismatch';
  let diff = 0;
  for (let i = 0; i < mine.length; i++) diff |= mine.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0 ? null : 'signature mismatch';
}

// POST with a JSON body — correct for chat.postMessage and the other write
// methods.
const slack = async (method: string, payload: unknown) => {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${BOT_TOKEN}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
  });
  return res.json().catch(() => ({ ok: false, error: 'bad json' }));
};

// GET with query params — required for the lookup methods.
//
// users.info and conversations.info do NOT accept a JSON body: they return
// invalid_arguments and the caller falls back to whatever it had. That is why
// the first relayed messages read "U0C09MWH64W asked in C0C162ZK2GY" instead of
// "Mr Rashid asked in #pure-daily-care" — the failure was silent, because a
// fallback that looks like data hides a broken call.
const slackGet = async (method: string, params: Record<string, string>) => {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${BOT_TOKEN}` } });
  return res.json().catch(() => ({ ok: false, error: 'bad json' }));
};

/** Slack writes mentions as <@U123>. Strip them and tidy for the assistant. */
function cleanQuestion(text: string): string {
  return String(text || '')
    .replace(/<@[UW][A-Z0-9]+>/g, ' ')                 // user mentions
    .replace(/<#C[A-Z0-9]+\|([^>]*)>/g, '#$1')          // channel refs
    .replace(/<(https?:\/\/[^|>]+)(\|[^>]*)?>/g, '$1')  // links
    .replace(/\s+/g, ' ')
    .trim();
}

// The actual work, run AFTER Slack has been ACKed.
async function handleEvent(ev: Record<string, any>, eventId: string) {
  const { data: cfg } = await admin.from('slack_config').select('*').eq('id', 1).maybeSingle();
  if (!cfg?.enabled) return;
  if (!cfg.dest_channel_id || !cfg.answer_as_user_id) return;

  const channel = String(ev.channel || '');
  const user = String(ev.user || '');
  const text = String(ev.text || '');

  // Only the channels we were told to watch.
  if (!Array.isArray(cfg.source_channel_ids) || !cfg.source_channel_ids.includes(channel)) return;
  // Never react to the destination channel — that is how a loop starts.
  if (channel === cfg.dest_channel_id) return;

  // Which watched person was tagged? No tag, nothing to do.
  const mentioned = (Array.isArray(cfg.watch_user_ids) ? cfg.watch_user_ids : [])
    .find((u: string) => text.includes(`<@${u}>`));
  if (!mentioned) return;

  const question = cleanQuestion(text);
  if (!question) return;

  // Claim this event. The unique index on slack_event_id means a Slack retry
  // loses the race and returns here instead of posting a duplicate answer.
  const { data: claim, error: claimErr } = await admin.from('slack_relay_log').insert({
    slack_event_id: eventId, source_channel: channel, source_user: user,
    mentioned_user: mentioned, question, dest_channel: cfg.dest_channel_id,
  }).select('id').single();
  if (claimErr || !claim) return;   // already handled

  // ── Channel context ──────────────────────────────────────────────────────
  // A question asked in #pure-daily-care is about Pure Daily Care. The person
  // asking knows that and does not say it, so "how are we doing?" would reach
  // the assistant with no subject and get answered across every brand.
  //
  // Phrased as a DEFAULT, not a constraint: a question that names a different
  // brand must still be answered about that brand. Prefixing "only answer about
  // X" would break the perfectly reasonable act of asking about another brand
  // from this channel.
  const brand = (cfg.channel_brands || {})[channel];
  const asked = brand
    ? `[Context: this was asked in the Slack channel for the brand "${brand}". If the question does not name a brand, it is about "${brand}" — resolve "we", "our" and "us" to that brand. If it names a different brand, answer about that one instead.]\n\n${question}`
    : question;

  let answer = '';
  let failure = '';
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/ai-chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': AI_INTERNAL_SECRET,
        // The platform still wants a bearer on function-to-function calls.
        Authorization: `Bearer ${SERVICE_ROLE}`,
      },
      body: JSON.stringify({ message: asked, as_user_id: cfg.answer_as_user_id }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j?.error) failure = j?.error || `assistant HTTP ${res.status}`;
    else answer = String(j?.reply || '').trim();
    if (!failure && !answer) failure = 'the assistant returned an empty answer';
  } catch (e) {
    failure = String(e);
  }

  // Resolve names so the post reads like a human forwarded it. Best-effort —
  // an unresolvable name must never stop the answer being delivered.
  const nameOf = async (id: string) => {
    if (!id) return 'someone';
    const r = await slackGet('users.info', { user: id }).catch(() => null);
    return r?.ok ? (r.user.real_name || r.user.name) : id;
  };
  const chanOf = async (id: string) => {
    const r = await slackGet('conversations.info', { channel: id }).catch(() => null);
    return r?.ok ? `#${r.channel.name}` : id;
  };
  const [askerName, taggedName, chanName] = await Promise.all([
    nameOf(user), nameOf(mentioned), chanOf(channel),
  ]);

  const header = `*${askerName}* asked in ${chanName} (tagged *${taggedName}*):\n> ${question}`;
  const bodyText = failure
    ? `${header}\n\n:warning: Could not answer — ${failure}`
    : `${header}\n\n${answer}`;

  const posted = await slack('chat.postMessage', {
    channel: cfg.dest_channel_id,
    text: bodyText,
    unfurl_links: false,
    unfurl_media: false,
  });

  await admin.from('slack_relay_log').update({
    answer: answer || null,
    posted: posted?.ok === true,
    error: failure || (posted?.ok ? null : `slack: ${posted?.error}`),
    finished_at: new Date().toISOString(),
  }).eq('id', claim.id);
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('ok');

  const raw = await req.text();

  // Slack proves it owns the URL by POSTing a challenge. Verify the signature
  // for this too — an unsigned handshake would let anyone claim the endpoint.
  const bad = await verifySlack(req, raw);
  if (bad) return new Response(JSON.stringify({ error: bad }), { status: 401 });

  let payload: Record<string, any> = {};
  try { payload = JSON.parse(raw); } catch { return new Response('bad json', { status: 400 }); }

  if (payload.type === 'url_verification') {
    return new Response(JSON.stringify({ challenge: payload.challenge }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (payload.type === 'event_callback') {
    const ev = payload.event || {};
    // Ignore our own posts, edits, joins, and anything from a bot — otherwise
    // the answer we publish becomes the next question.
    const isEcho = ev.bot_id || ev.subtype || ev.user === payload.authorizations?.[0]?.user_id;
    if (ev.type === 'message' && !isEcho) {
      // ACK FIRST. Slack allows 3 seconds and the assistant needs far longer,
      // so the work is started and deliberately not awaited.
      handleEvent(ev, String(payload.event_id || `${ev.channel}:${ev.ts}`))
        .catch((e) => console.error('slack relay failed', e));
    }
  }

  return new Response('', { status: 200 });
});
