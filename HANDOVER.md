# WurxOS — handover for a new machine

Written 2026-10-13. Everything needed to go from an empty laptop to working on
this repo, plus the state of the work in flight and the traps that have already
cost us time.

Read `CLAUDE.md` after this one — it is the standing project context and it is
loaded automatically by Claude Code. This file is the *situational* half: what
is half-finished, what is waiting on you, and what has already gone wrong.

`DEPENDENCIES.md` covers what to install and what every package is for,
including the Deno imports and the external APIs Buddy calls.

---

## 1. What this is

**WurxOS** — the ops platform for Wurx Media, a TikTok Shop affiliate agency of
~30 people. Brands, client reports, attendance, leave, performance, salaries,
incentives, agenda meetings, approvals, push notifications, client portals, and
**Wurx Buddy** (an agentic RAG assistant).

| | |
|---|---|
| Frontend | Vite + React 19 + React Router v6 + TanStack Query + Bootstrap 5 |
| Backend | Supabase — Postgres 17, RLS, Realtime, Edge Functions (Deno) |
| Hosting | Vercel |
| Repo | `git@github.com:RashidNazeer/WurxOS.git` (private) |
| Timezone | the database is locked to `Asia/Karachi` (mig 095) |

---

## 2. Setting up the new laptop

### 2.1 Prerequisites

- **Node 24.x** (this machine ran `v24.20.0`, npm `11.19.0`). The test script
  uses `node --experimental-strip-types`, which needs Node 22+.
- **Git**, and a GitHub account with access to `RashidNazeer/WurxOS`.
- No global Supabase or Vercel CLI needed — both are used through `npx`.

### 2.2 Clone and install

```bash
git clone git@github.com:RashidNazeer/WurxOS.git
cd WurxOS
npm ci
```

If SSH gives trouble (see §7.3), clone over HTTPS instead:
`git clone https://github.com/RashidNazeer/WurxOS.git`

### 2.3 Environment files — THE PART THAT DOES NOT TRAVEL

Every `.env*` file is gitignored, so **none of this comes with the clone**.
Recreate them by hand. Names only below; get the values from the Supabase
dashboard, or from the old laptop before you wipe it.

**`.env.local`** — what `npm run dev` actually reads (Vite auto-loads it).
Without these two the app throws on startup in `src/lib/supabase.js`:

```
VITE_SUPABASE_URL=          # https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=     # Supabase > Project Settings > API > anon public
```

**`.env.dev`** — not auto-loaded by Vite; it is the credentials file the
scripts and tooling read:

```
WURXOS_DEV_PROJECT_REF=
WURXOS_DEV_DB_PASSWORD=
WURXOS_DEV_DB_URL=
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
WURXOS_DEV_SUPABASE_SERVICE_ROLE_KEY=
OPEN_AI_API_KEY=
OPEN_AI_API_KEY_FALLBACK=
GROQ_Fallback=
Gemini_Fallback=
OPEN_AI_NVA=
NEM_API=
Tavily_API=
AI_INGEST_SECRET=
```

**`.env.demo`** — demo mode, points at the separate demo project. Lower
priority; copy it if you use demo mode.

> **Do not put a `service_role` key in a Downloads folder or paste it into
> chat.** It bypasses every RLS policy — salaries, performance, attendance,
> every report. See §9.

### 2.4 Run it

```bash
npm run dev          # local dev server
npm run build        # production build (must pass before any PR)
npm test             # 501 unit tests, all stubbed, no network, no API spend
npx --yes deno@2 check supabase/functions/assistant/index.ts   # type-check edge fns
```

---

## 3. The Supabase projects

| Project | Ref | Notes |
|---|---|---|
| **Production** | `xoaaidgvblondjpvxjqp` | the live agency |
| **Dev** | `vyvkwbvreeycmmnikqbz` | reports/ingestion were wiped 2026-10; users, roles and brand names kept |
| Demo | `rjruqftkzetrltasiouo` | demo mode only |

### 3.1 Applying migrations

```bash
npx supabase link --project-ref <ref>
npx supabase db push
```

`supabase db push` applies **every** unapplied migration on the branch, so read
the output before confirming. For one-off data work, the SQL Editor is usually
safer — that is what `ops/*.sql` is for.

### 3.2 ⚠ The CLI account trap (cost us five days)

On the old laptop, every production CLI call returned:

```
403 — your account does not have the necessary privileges
```

The cause was **not** an expired session. `npx supabase projects list` showed
the CLI was authenticated as an account that could only see two unrelated
projects (`wurxmediahub-dev`, `wurxmediahub-prod`) — the WurxOS projects were
not in its list at all.

**On the new laptop, check this first:**

```bash
npx supabase login
npx supabase projects list      # xoaaidgvblondjpvxjqp MUST appear
```

Dev kept working throughout because dev operations were driven by
`WURXOS_DEV_DB_PASSWORD` (a direct database password), which does not need the
management API. Production had no such password stored.

---

## 4. Deploying

```bash
npx vercel --prod --yes
```

**`vercel --prod` ships whatever branch is checked out at that moment**, not
`main`. Check `git branch --show-current` before deploying.

`.vercelignore` excludes `dist`, `supabase`, `wurx-buddy`, `.claude` and the
docs — uploading those once made CLI deploys abort on slow connections. Leave
it alone; there is a stale branch (`chore/vercelignore-secrets`) whose version
is **older** and would undo this. Do not merge it.

If a deploy fails but `npm run build` passes locally, the cause is on the
Vercel side: CLI authentication, missing `VITE_SUPABASE_URL` /
`VITE_SUPABASE_ANON_KEY` on the Vercel project, or the wrong branch.

---

## 5. Where things live

```
src/                         the React app
  lib/                       API layer (reportsApi, brandsApi, teamApi, adminApi, buddyLogic…)
  pages/, components/        screens
  styles/tokens.css          design tokens — NEVER hardcode a hex
supabase/
  migrations/NNN_name.sql    highest is 421
  functions/<name>/index.ts  edge functions (Deno)
  functions/_shared/ai/      Wurx Buddy: agent, retrieval, tools, web search
  functions/_shared/ai/__tests__/   the unit tests (run from repo root)
ops/                         one-off operational SQL (see §8)
wurx-buddy/                  Buddy design docs, runbooks, dev scripts, app guides
CLAUDE.md                    standing project context
```

---

## 6. Migrations — read this before adding one

**Never reuse a number, even on a different branch.** The Supabase CLI keys its
ledger on the numeric prefix alone, so two files sharing a number means one is
skipped **silently, while reporting success**.

This has happened **three times**:

| Collision | Cost |
|---|---|
| `407` ×2 | production ran for weeks with the Brand Switcher temporary-cover UI live and none of its tables. Recovered by re-applying the loser as mig **414**. |
| `414` ×2 | `414_approval_reads.sql` would have been skipped on production, because 414 was already recorded as the brand-temp re-run. Renumbered to **418**. |
| `419` ×2 | `419_ipc_sees_paid_collab_brands.sql` never ran — merged, reported applied, silently skipped. Renumbered to **420**, and **still not applied anywhere**. |

Before pushing a merge:

```bash
ls supabase/migrations | cut -c1-3 | sort | uniq -d     # must print nothing
```

**Next free number: 422.**

---

## 7. Working practices

### 7.1 `main` is protected

Direct pushes are rejected: `GH013 — Changes must be made through a pull
request`. That applies to everyone. Branch, push, open a PR, merge in the UI.

### 7.2 Commit identity

```
RashidNazeer <wurxmedia@gmail.com>
```

Note: some recent commits on `main` came from a second identity,
`TSRashid <mrrashid3255@gmail.com>` — another machine with different git
config. Set `user.name` / `user.email` on the new laptop to match the first.

### 7.3 SSH to GitHub is unreliable here

`ssh: connect to host github.com port 22: Connection timed out` happened
repeatedly. HTTPS works:

```bash
git push https://github.com/RashidNazeer/WurxOS.git <branch>:<branch>
```

### 7.4 Branch hygiene

There are ~90 remote branches, most merged and dead. Five were checked on
2026-10-12 and **none should be merged**: `chore/merge-all-local`,
`feat/approvals-mark-read` (both byte-identical to main),
`chore/redeploy-2026-10-02`, `feat/owner-decisions` (both zero diff), and
`chore/vercelignore-secrets` (**would regress `.vercelignore`**).

---

## 8. Open items — what is actually waiting on you

Ordered by what bites first.

### 8.1 🔴 TLs and APCs may still not see their new brands

**Status: unresolved as of 2026-10-13.**

After the October restructure, TLs reported seeing reports for their *old*
brands and not their new ones, then APCs reported the same.

**This is a data problem, not an app problem.** Verified by reading the code:

- TL brand picker: `brands where owner_id = me and status = 'active'`
- APC brand picker: `brand_assignments where user_id = me`, active brands only
- report visibility: `reports_select → can_view_report → can_view_brand →
  b_owner = me` **or** a `brand_assignments` row for me

No cache, no denormalised copy, no role shortcut. The `brand_assignments`
branch of `can_view_brand` has existed since mig **316**, which production has,
so mig 420 is *not* the fix (this was checked and disproven).

**Action:** run `ops/fix-brand-access.sql` in the production SQL Editor. It is
brands-only and idempotent. Run it as-is first — it prints `current -> intended`
for all 19 brands and changes nothing. If `current` already matches `intended`
everywhere, the data is right and the cause is something else; send that output
on. Otherwise set `v_dry_run := false` and run again.

Then run `ops/audit-org-structure.sql` query 2. Empty = structure correct.

### 8.2 🔴 Rotate the production `service_role` key

A production `service_role` key (ref `xoaaidgvblondjpvxjqp`, valid to
**2036-04-14**) was placed in `C:\Users\Umar Ilyas\Downloads\env.download` on
the old laptop, alongside the OpenAI key, Euka tokens and a Discord webhook.

That key bypasses **every** RLS policy. Rotate it (Supabase → Project Settings
→ API → roll `service_role`), delete that file, and do not carry it to the new
machine. Move the other keys into `.env.dev`.

### 8.3 🟡 Migration 420 is renumbered but never applied

`420_ipc_sees_paid_collab_brands.sql` — the IPC visibility fix from PR #50 that
the `419` collision swallowed. It is in the repo and has run **nowhere**. It
widens RLS (an IPC gains sight of paid-collab brands), so it needs a deliberate
decision, not a reflex `db push`.

### 8.4 🟡 Wurx Buddy web search ships OFF

Everything is merged and tested but switched off. To enable:

1. apply migrations **415, 416, 417**
2. `npx supabase functions deploy assistant`
3. set function secrets `TAVILY_API_KEY`, and `BRAVE_API_KEY` when you have it
4. stand up a SearXNG instance and add `json` to `search.formats` in its
   `settings.yml` — **without that it returns HTTP 403**, which is the single
   most likely setup failure
5. set `web_allowed_roles` before switching it on; `null` means every role that
   can use Buddy

Migration **421** (`admin_revoke_user_sessions`) is also unapplied — it is what
kills an ex-employee's live session.

### 8.5 🟢 Smaller things

- The Google Sheet with the team structure still shows the **old** OL layout
  (Klassy Network under both OLs, apothecary under neither). The database
  follows the 12 Oct correction: Klassy Network → Mustafa only, apothecary →
  Fahad. Update the sheet so they stop drifting.
- `Test APC` reports to `Test Team Lead`, who left in July 2026. Harmless but
  it looks wrong on the org chart. Delete the test accounts.
- `wurx-buddy/` still contains design docs whose status lines are older than
  the code; `architecture.md` has a header table listing where it was overtaken.

---

## 9. Hard-won lessons — do not relearn these

**A silent `INNER JOIN` is the most expensive bug in this project.** The
restructure script joined brand rows to people rows on exact name strings.
After the people list was changed to full names (`Haider` → `Haider Ali`) but
the brand list was not, the join matched nothing and **13 of 19 brands were
never reassigned** — with no error, and a success message. It surfaced days
later as "the TLs cannot see their reports". If a loop drives writes, assert
that it matched the number of rows you expected.

**Soft delete is deliberate.** `delete-user` sets `is_active = false` +
`deleted_at` rather than deleting the row, because `verified_by` / `approved_by`
are `on delete set null` — erasing the row would blank out who approved what.
Ex-employees are therefore visible under the **Ex-employees** tab on each
Employees roster.

**Revoking access needs three things, not one.** The profile flag kills role
checks, `auth.users.deleted_at` refuses sign-in, but an already-issued JWT is
stateless and keeps working until it expires. Only deleting `auth.sessions` and
`auth.refresh_tokens` ends a live session (mig 421).

**`brands.owner_id` is `NOT NULL`.** A brand always has an owner, so a dormant
client still points at whichever TL last held it. That is why inactive brands
appeared under TLs until they were filtered out in the UI, and why a brand
owner cannot simply be retired — reassign their brands first.

**The hierarchy's "unassigned" count was dead for months.** It tested
`!b.ownerId` against a `NOT NULL` column, so it was always zero. It now counts
active brands with no APC — which is what is left behind when an APC leaves.

**Numbers come from SQL, words from retrieval.** Buddy's core rule. Every
factual sentence it writes carries `[D#]`, `[S#]` or `[W#]`, and the server
strips citation ids the tools did not actually return.

---

## 10. First hour on the new laptop

```bash
git clone git@github.com:RashidNazeer/WurxOS.git && cd WurxOS
npm ci
# create .env.local and .env.dev (§2.3)
npm run build                     # must pass
npm test                          # expect 501 tests, 0 fail
npx supabase login
npx supabase projects list        # xoaaidgvblondjpvxjqp MUST be listed (§3.2)
ls supabase/migrations | cut -c1-3 | sort | uniq -d    # must print nothing
```

Then work through §8, starting with `ops/fix-brand-access.sql`.
