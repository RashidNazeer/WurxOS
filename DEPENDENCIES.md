# WurxOS — dependencies

Written 2026-10-13. Everything this project needs to build, test, deploy and
operate, and what each thing is actually for. Companion to `HANDOVER.md`
(setup and current state) and `CLAUDE.md` (standing project context).

---

## 1. System prerequisites

Install these before anything else.

| Tool | Version | Why |
|---|---|---|
| **Node.js** | **24.x** (verified on `v24.20.0`) | builds the app and runs the test suite |
| **npm** | 11.x (ships with Node 24) | package manager; `npm ci` is the install command |
| **Git** | any recent | plus a GitHub account with access to `RashidNazeer/WurxOS` |

**Node 22+ is a hard floor, not a preference.** The test script runs
`node --experimental-strip-types`, which executes TypeScript test files
directly with no build step. On an older Node, `npm test` fails outright.

Nothing else needs a global install. The Supabase CLI, Deno and the Vercel CLI
are all invoked through `npx`, so they are pulled on demand and stay pinned per
invocation.

---

## 2. Runtime dependencies (`dependencies`)

These ship in the browser bundle.

### Core framework

| Package | Version | Role |
|---|---|---|
| `react` | ^19.0.0 | UI |
| `react-dom` | ^19.0.0 | DOM renderer |
| `react-router-dom` | ^6.28.0 | routing. **v6, not v7** — the route syntax differs |
| `@tanstack/react-query` | ^5.99.0 | all server state: caching, refetching, invalidation |
| `@supabase/supabase-js` | ^2.45.4 | database, auth, realtime, storage, edge-function calls |

### UI and styling

| Package | Version | Role |
|---|---|---|
| `bootstrap` | ^5.3.8 | base CSS layer |
| `bootstrap-icons` | ^1.13.1 | icon set (`bi bi-*`) |
| `recharts` | ^3.8.1 | charts |

> Colours come from `src/styles/tokens.css`, never from Bootstrap defaults and
> never hardcoded. Both light and dark themes resolve through those tokens.

### Rich text — TipTap

Ten packages, all pinned to **^2.27.2** and upgraded together: `@tiptap/react`,
`@tiptap/pm`, `@tiptap/starter-kit`, and the extensions `extension-link`,
`extension-placeholder`, `extension-task-item`, `extension-task-list`,
`extension-text-align`, `extension-text-style`, `extension-underline`.

Used by the report editor. **Upgrade them as a set** — mixing `@tiptap/*`
minor versions breaks the editor schema at runtime, not at build time.

### Documents, export and import

| Package | Version | Role |
|---|---|---|
| `docx` | ^9.6.1 | generates .docx report exports |
| `jspdf` | ^4.2.1 | PDF export |
| `pdfjs-dist` | ^4.10.38 | **parses** uploaded PDFs (`pdfReportParser`) |
| `xlsx` | ^0.18.5 | reads/writes spreadsheets |
| `html-to-image` | ^1.11.13 | renders DOM to an image for sharing |

These are the four largest chunks in the bundle (~360–430 kB each) and are all
lazily imported — keep it that way.

### Markdown and sanitising

| Package | Version | Role |
|---|---|---|
| `marked` | ^18.0.14 | renders Markdown — Wurx Buddy's answers, among others |
| `dompurify` | ^3.4.2 | **sanitises that HTML before it reaches the DOM** |

`marked` and `dompurify` are a pair. Buddy renders model output and fetched web
content; `src/lib/markdownCore.js` always pipes `marked` through `dompurify`.
Never render model or web HTML without it.

---

## 3. Build and dev dependencies (`devDependencies`)

| Package | Version | Role |
|---|---|---|
| `vite` | ^6.0.3 | dev server and bundler |
| `@vitejs/plugin-react` | ^4.3.4 | React fast refresh + JSX |
| `pg` | ^8.23.0 | Postgres client for local scripts, **not** shipped to the browser |

`pg` is only used by Node-side maintenance scripts that connect straight to the
database. If a script fails with `Cannot find package 'pg'`, run `npm ci` —
it is declared but easy to miss when `node_modules` was installed without dev
dependencies.

---

## 4. Edge function dependencies (Deno)

The functions under `supabase/functions/` run on **Deno**, not Node. They have
no `package.json`; they import by URL, resolved at deploy time.

| Import | Used by |
|---|---|
| `https://esm.sh/@supabase/supabase-js@2.45.0` | most functions |
| `https://esm.sh/@supabase/supabase-js@2.45.4` | newer functions |
| `https://esm.sh/web-push@3.6.7` | `send-push` (web push notifications) |

Two different `supabase-js` versions are pinned across functions. That is
harmless — each function bundles its own — but if you touch a function, keep
its existing pin rather than bumping it in isolation.

Type-check a function without deploying:

```bash
npx --yes deno@2 check supabase/functions/assistant/index.ts
```

### External HTTP APIs Buddy calls

No SDKs — all plain `fetch` against REST, deliberately, so there is nothing to
version:

| Service | Endpoint | Auth header |
|---|---|---|
| OpenAI | `/v1/responses` | `Authorization: Bearer` |
| Groq | `api.groq.com/openai/v1` | `Authorization: Bearer` |
| Gemini | `generativelanguage.googleapis.com/.../openai` | `Authorization: Bearer` |
| NVIDIA | `integrate.api.nvidia.com/v1` | `Authorization: Bearer` |
| Tavily | `api.tavily.com/search`, `/extract` | `Authorization: Bearer` |
| **Brave** | `api.search.brave.com/res/v1/web/search` | **`X-Subscription-Token`** — *not* a bearer token |
| SearXNG | your own instance, `POST /search` | none |

Tavily's own guidance is never to use their CLI as a production runtime, which
is why this is REST.

---

## 5. Tooling used through `npx` (no install needed)

| Command | What it is for |
|---|---|
| `npx supabase link --project-ref <ref>` | point the CLI at a project |
| `npx supabase db push` | apply migrations |
| `npx supabase functions deploy <name>` | deploy an edge function |
| `npx supabase projects list` | **check which account you are on** (see `HANDOVER.md` §3.2) |
| `npx --yes deno@2 check <file>` | type-check edge functions |
| `npx vercel --prod --yes` | deploy the site |

Two flags worth remembering:

- `slack-events` must be deployed with `--no-verify-jwt` (Slack signs its own
  requests)
- `tiktok-oauth` serves a public redirect, since the advertiser approving an ad
  account has no WurxOS session

---

## 6. `wurx-buddy/` tooling

A separate `package.json` for dev-only scripts (ingestion, crawling,
evaluation, a local assistant server). Not part of the site build.

| Package | Version |
|---|---|
| `@supabase/supabase-js` | ^2.45.4 |
| `pg` | ^8.13.0 |

Its scripts read `../.env.dev` from the repo root. The unit tests no longer
live here — they moved to `supabase/functions/_shared/ai/__tests__/` and run
from the repo root.

---

## 7. Service accounts and keys

Not npm packages, but the project does not run without them. Values go in
`.env.local` / `.env.dev` (both gitignored) or in Supabase function secrets —
**never in the repo**. See `HANDOVER.md` §2.3 for the full variable list.

| Service | Needed for | Where it lives |
|---|---|---|
| **Supabase** | everything | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` |
| **Vercel** | deploys | CLI session / token |
| **OpenAI** | Buddy answers + embeddings | `OPEN_AI_API_KEY` (+ `_FALLBACK`) |
| Groq / Gemini / NVIDIA | free-tier Buddy fallbacks | `GROQ_Fallback`, `Gemini_Fallback`, `OPEN_AI_NVA`, `NEM_API` |
| **Tavily** | Buddy web search + page extraction | `Tavily_API` → secret `TAVILY_API_KEY` |
| **Brave** | Buddy web search | `BRAVE_API_KEY` — **not yet obtained** |
| Euka | TikTok Shop metrics | `EUKA_TOKEN`, `EUKA_API_KEY`, per-brand keys |
| Slack | `slack-events` relay | `AI_INTERNAL_SECRET` |
| Web push | notifications | `VITE_VAPID_PUBLIC_KEY` + private counterpart |

> A `service_role` key bypasses **every** RLS policy. It belongs in Supabase
> function secrets only — never in `.env.local`, never in a Downloads folder,
> never in chat.

---

## 8. Commands

```bash
npm ci                 # install exactly what package-lock.json pins
npm run dev            # dev server
npm run build          # production build — must pass before any PR
npm run build:dev      # build against the dev project
npm run build:demo     # demo mode build
npm test               # 501 unit tests: stubbed fetch, no network, no API spend
```

`npm test` costs nothing and calls no external service. Every fetch is stubbed
and DNS is injected, so it is safe to run in a loop.

Other suites, run only when touching their area: `test:halo-v2`,
`test:brand-switch`, `test:buddy`, `test:euka-timeouts` (that last one needs
Deno and network).

---

## 9. Upgrade notes

- **`npm ci`, not `npm install`**, unless you intend to move versions.
  `package-lock.json` is the source of truth.
- **React 19 and React Router 6.** Do not take Router 7 without checking the
  route definitions in `src/App.jsx`.
- **TipTap moves as a set** — all ten packages together.
- **`xlsx` is pinned at 0.18.5.** Newer releases moved off the npm registry;
  check before bumping.
- **Edge functions pin their own `supabase-js`** by URL. Changing one does not
  affect the others, and should not be done casually.
