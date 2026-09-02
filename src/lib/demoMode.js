// ============================================================
// Demo mode — the switch that turns this build into a sales demo.
//
// WHY THIS EXISTS
// ---------------
// The app needs to be shown to people outside the company (prospective
// buyers, partners) without exposing a single row of real client data.
// Masking data in the browser was rejected: the real rows would still be
// sent to their laptop and sit in the network tab. So a demo is instead a
// SEPARATE Supabase project holding invented people and brands, and this
// module is what tells the running app it is pointed at that project.
//
// Demo mode only ever ADDS things that make a walkthrough possible
// (a role switcher) and REMOVES things that would reach a real third-party
// API. It never changes a calculation, a permission or a stored value —
// what the visitor sees the app do is exactly what it does at work.
//
// THE GUARD
// ---------
// isDemo() is false unless BOTH are true:
//   1. VITE_DEMO_MODE === 'true'
//   2. the Supabase URL is NOT the production project
//
// Point 2 is the part that matters. A stray VITE_DEMO_MODE in the wrong
// .env, or a Vercel env var set on the wrong project, would otherwise hand
// every visitor a one-click "sign in as the Boss" control against the real
// database. The ref is hardcoded rather than read from config on purpose:
// a guard that can be switched off by the same config it is guarding
// against is not a guard.
// ============================================================

// The production project ref (see the README / supabase link). Demo mode is
// refused against this host no matter what the environment says.
const PRODUCTION_REF = 'xoaaidgvblondjpvxjqp';

const rawUrl = String(import.meta.env.VITE_SUPABASE_URL || '');
const flagOn = import.meta.env.VITE_DEMO_MODE === 'true';
const pointedAtProduction = rawUrl.includes(PRODUCTION_REF);

// Evaluated once at module load: the answer cannot change at runtime, and
// making it a constant means no call site can accidentally re-derive it
// from something weaker.
export const DEMO_MODE = flagOn && !pointedAtProduction;

// Shout if someone tries. Silence here would mean a demo build quietly
// running against production and nobody finding out until the walkthrough.
if (flagOn && pointedAtProduction) {
  // eslint-disable-next-line no-console
  console.error(
    '[demo] VITE_DEMO_MODE is set but VITE_SUPABASE_URL points at the PRODUCTION ' +
    'project. Demo features are disabled. Point this build at the demo project.',
  );
}

// Display name for the product. Prod leaves VITE_APP_NAME unset and keeps
// its own name; the demo build sets it. Note this is the RUNTIME name used
// by code that builds strings dynamically — the static "WurxOS" text baked
// into JSX is swapped at build time by the demoBranding() plugin in
// vite.config.js, so the two must agree.
export const APP_NAME = import.meta.env.VITE_APP_NAME || 'WurxOS';

// Shared password for every seeded demo account. Only ever used by the role
// switcher, and only in a build that has already passed the guard above.
// It is not a secret: the demo database contains nothing worth protecting,
// which is the entire point of building one.
export const DEMO_PASSWORD = import.meta.env.VITE_DEMO_PASSWORD || 'OpsDeckDemo!2026';

// Anything that calls a third party — Euka, OpenAI, TikTok — is switched off
// in demo mode. The pages still render their seeded data so the feature can
// be demonstrated; it is only the live "go and fetch it now" action that is
// withheld, because the demo project holds no API keys and the production
// keys must never be handed to a demo deployment.
export const LIVE_INTEGRATIONS = !DEMO_MODE;

// Standard copy for a control that demo mode has disabled, so every one of
// them says the same thing rather than each page inventing its own wording.
export const DEMO_DISABLED_HINT =
  'Disabled in the demo — this would call the live API. The data shown below is sample data.';

// ── The hard stop ───────────────────────────────────────────────────────────
// Edge functions a demo build must never reach. Two kinds:
//
//   * outbound integrations — they would need real Euka / OpenAI / TikTok /
//     Google credentials, which is precisely what must not be deployed
//     alongside a demo. Blocked at the call rather than left to fail on a
//     missing secret, so there is no version of this where a key gets added
//     "just to make the demo work" and starts pulling real client data.
//
//   * wipe-data — one Boss-only click that TRUNCATEs everything. Recoverable
//     (re-run the seed) but not in the ninety seconds you would have during a
//     walkthrough, and a visitor exploring the Boss account will find it.
//
// Everything else is allowed: creating an employee, sending a notification and
// so on are the product, and they only ever touch the demo's own database.
export const DEMO_BLOCKED_FUNCTIONS = new Set([
  'ai-chat',
  'euka-api',
  'euka-checkpoint-autofill',
  'euka-report-autofill',
  'video-review-targets',
  'creator-sheet',
  'tiktok-oauth',
  'wipe-data',
]);

// Throws if `name` is blocked in this build. Call sites that reach an edge
// function by raw fetch (rather than supabase.functions.invoke) must call this
// themselves — supabase.js can only wrap the ones that go through the client.
export function assertAllowedInDemo(name) {
  if (!DEMO_MODE) return;
  if (!DEMO_BLOCKED_FUNCTIONS.has(name)) return;
  throw new Error(
    name === 'wipe-data'
      ? 'Disabled in the demo. This would erase the sample data everyone is looking at.'
      : DEMO_DISABLED_HINT,
  );
}
