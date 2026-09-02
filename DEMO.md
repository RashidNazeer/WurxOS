# OpsDeck — the sales demo

A complete, working copy of this app running on an invented company, for showing
the product to people outside Wurx Media without exposing a single row of real
data.

**Live:** https://opsdeck-demo.vercel.app
**Password for every demo account:** `OpsDeckDemo!2026`

---

## The short version

It is the same code, pointed at a different database, with the name swapped at
build time. Nothing is mocked. Every calculation, permission and workflow is the
real one — the people and numbers are invented.

|  | Production | Demo |
|---|---|---|
| Supabase project | `xoaaidgvblondjpvxjqp` (org *MrRashid*) | `rjruqftkzetrltasiouo` (org *OpsDeck Demo*, **free plan**) |
| Vercel project | `wurxos` | `opsdeck-demo` |
| Name on screen | WurxOS / Wurx Media | OpsDeck / Meridian Media |
| Data | real clients | 15 invented people, 8 invented brands |

The two share no infrastructure. The demo cannot read production, and a mistake
in the demo cannot reach it.

---

## Walking someone through it

Sign in as anyone; a **demo bar** sits at the bottom of the screen with a
*Switch role* dropdown. Picking a person genuinely signs in as them and reloads,
so what you see is what their permissions actually allow — not a costume.

A suggested route, which shows the most product in the fewest clicks:

1. **Adrian Vance — Founder.** Everything: payroll, every brand, performance
   across the company.
2. **Priya Raghavan — Operations Lead.** The week's engine: verifying incentive
   plans, rating APCs, chairing the agenda.
3. **Marcus Bell — Team Lead.** Four brands and three people. Note his
   commission-tier incentive lines.
4. **Leo Fontaine — APC.** The floor: two brands, his own day, his own report.
5. **Dana Whitfield — Ads Manager.** Sees **only** her four granted brands —
   good place to make the point that the permission model is real.
6. **Ruth Adeyemi — IPC.** Sees **zero** affiliate brands, by design — she is on
   the paid-collab side.

Worth pointing at while you are there:

- **Jonah Reid** sits in the *warning* band; **Mira Castellanos** in
  *promotion*. The thresholds are doing real work.
- **Bloom Botanicals** has a temporary cover assignment (Ivan covering Nadia),
  which the app treats differently from a permanent one.
- **Marcus Bell's** incentive plan carries both commission modes: one line with
  a benchmark, one with none (pays on everything).

## What is switched off

Anything that would call a third party is blocked before it leaves the browser —
Euka, OpenAI, TikTok and the Google Sheets bridge. The pages still show their
seeded data so the features can be demonstrated; only the live *fetch it now*
buttons are inert. `wipe-data` is blocked too, so a curious visitor on the Boss
account cannot erase the demo mid-walkthrough.

The list lives in `DEMO_BLOCKED_FUNCTIONS` in [src/lib/demoMode.js](src/lib/demoMode.js).

---

## Running it again

Everything is driven by two env files. `.env.demo` is committed (an anon key and
a demo password are public by design); `.env.demo.local` holds the service key
and DB URL and is gitignored.

```bash
npm run build:demo          # demo build (branding swapped, demo bar included)
npm run dev:demo            # same, locally on :3000

node scripts/seed-demo.mjs           # seed, skipping what already exists
node scripts/seed-demo.mjs --reset   # wipe and rebuild the whole company
node scripts/demo-smoke.mjs          # sign in as every role, count what they see
```

Re-deploying: build, then deploy the `dist/` folder to the `opsdeck-demo`
Vercel project. Deploy from a **copy** of `dist`, not from the repo — the repo's
`.vercel` link points at production, and running `vercel --prod` in the repo
root ships to the real app.

The seed is dated relative to the day you run it, so re-running it in three
months produces a demo that looks current rather than abandoned.

---

## Two things to know

**The free project sleeps.** After 7 days with no traffic, Supabase pauses a
free project and it needs one click in the dashboard to wake (~2 min). Open the
demo the day before you show it.

**Demo mode refuses to run against production.** `demoMode.js` hardcodes the
production project ref and disables every demo feature if the app is pointed at
it — so a stray `VITE_DEMO_MODE` in the wrong place cannot put a
"sign in as the Boss" button on the real app. The guard is deliberately not
configurable by the same config it guards against.

---

## How the branding swap works

Production source is untouched. A Vite plugin (`demoBranding` in
[vite.config.js](vite.config.js)) does a case-sensitive string replace over
`src/` at build time, only when `VITE_DEMO_MODE=true`:

```
WurxMediaHub -> MeridianHub      WurxOS -> OpsDeck
Wurx Media   -> Meridian Media   Wurx   -> Meridian
WurxCrew     -> MeridianCrew
```

This is safe because every *functional* use of the name is lowercase
(`wurxos-theme`, `wurxos.sidebar.collapsed`, the `wurxos-nav` postMessage type),
so none of them match. **If a MixedCase form of the name ever becomes a storage
key or a message type, this plugin would rename it and silently break state
persistence** — keep new occurrences of the name to display text only.

The real logo and favicon are deleted from the demo output and replaced with a
generated SVG, so they are not reachable even by guessing the URL.

---

## Tearing it down

Delete the `opsdeck-demo` Vercel project and the *OpsDeck Demo* Supabase
organization. Nothing else is affected. The code changes are inert without
`VITE_DEMO_MODE`, so they can stay in the repo indefinitely.

---

## One thing found along the way

Rebuilding the schema from scratch surfaced that **migration 018
(`report_shares`) has never applied** — not here and not in production. It
references a `can_edit_report()` function that no migration creates and a
`reports.sections` column that does not exist. Production has no `report_shares`
table, no `get_shared_report` RPC, and [src/lib/reportShareApi.js](src/lib/reportShareApi.js)
is therefore dead code. It is dormant rather than broken — nothing calls it in
anger — but the share-link feature it was written for does not exist. Worth a
decision at some point: finish it or delete it.

The demo skips that migration (`supabase migration repair --status applied 018`),
which puts it in exactly the state production is in.
