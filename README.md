# WurxOS v2

Fresh rewrite of WurxOS on Supabase (Postgres + Auth + Edge Functions + Realtime).
Built feature-by-feature — authentication is the first milestone.

## Tech stack

- **Vite + React 19**
- **React Router v6**
- **Supabase** (Auth + Postgres + RLS)
- **Pure CSS design tokens** for light/dark theming (no Bootstrap dark-mode quirks)

## First-time setup

### 1. Install dependencies

```bash
cd a:/Projects/wurxos-v2
npm install
```

### 2. Run the SQL migration

Open the Supabase dashboard → **SQL Editor** → **New query**, paste the contents of
`supabase/migrations/001_profiles.sql`, and run it.

This creates:
- `public.profiles` table (mirrors `auth.users`, adds `display_name` + `role`)
- Auto-create trigger so a profile row is inserted on every signup
- RLS policies so users can only read/update their own profile

### 3. (Optional) Disable email confirmation for faster local testing

Supabase dashboard → **Authentication → Providers → Email** → toggle off
**"Confirm email"**. Re-enable it before production.

### 4. Start the dev server

```bash
npm run dev
```

Opens http://localhost:3000 automatically.

## Project structure

```
src/
├─ components/
│  ├─ auth/            LoginPage, SignupPage, AuthShell, ProtectedRoute
│  └─ common/          ThemeToggle, Icon
├─ contexts/           ThemeContext, AuthContext
├─ lib/                supabase client, roles config
├─ pages/              Dashboard (stub)
├─ styles/
│  ├─ tokens.css       ★ all colors live here — light + dark
│  ├─ global.css       base styles + form/button primitives
│  └─ auth.css         auth-page-specific styles
├─ App.jsx             router + providers
└─ main.jsx            entry
```

## Theming rule

**Every color in a component MUST reference a CSS variable** from `tokens.css`.
Do not hardcode hex values. This is how we avoid the dark/light mode
inconsistencies from v1.

Examples:
- ✅ `color: var(--text-primary)`
- ✅ `background: var(--surface-1)`
- ❌ `color: #0f172a`
- ❌ `background: #ffffff`

When a new color is needed, add a new token to `tokens.css` with values for
both `[data-theme='light']` and `[data-theme='dark']`.

## Roles & signup flow

Seven roles are defined in [`src/lib/roles.js`](src/lib/roles.js):
`boss`, `ol`, `tl`, `pctl`, `apc`, `ipc`, `developer`.

**Signup is Boss-only bootstrap**:
- The **first** signup on a fresh workspace automatically becomes the **Boss**
  (enforced by the `handle_new_user` SQL trigger).
- After that, the signup page locks itself and shows
  "Signups are disabled — contact your administrator".
- All other users are created by the Boss from the admin panel (M2).

The signup page calls an RPC `boss_exists()` to decide which UI to show.

## M2 setup — User management

Two extra pieces need to be deployed for Boss-managed user creation:

### a) Run migration 002

Supabase Dashboard → **SQL Editor** → **New query** → paste
[`supabase/migrations/002_profiles_admin.sql`](supabase/migrations/002_profiles_admin.sql)
→ **Run**.

Adds `is_active` / `created_by` columns, the `is_boss()` RLS helper,
Boss-admin SELECT/UPDATE policies, and a smarter `handle_new_user` trigger.

### b) Deploy the create-user Edge Function

The create-user flow uses an Edge Function so the Supabase **service role key**
never leaves the server.

**One-time**: install the Supabase CLI.
```bash
npm install -g supabase
supabase login
supabase link --project-ref xoaaidgvblondjpvxjqp
```

**Deploy**:
```bash
cd a:/Projects/wurxos-v2
supabase functions deploy create-user
```

The function reads `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from
Supabase's automatically-provided secrets — no manual env setup needed.

Once deployed, the Boss can create users from
**Dashboard → Manage Users → [role] → Add**.

## Roadmap

- [x] **M1** — Authentication (signup, login, logout, protected routes)
- [x] **M2** — User management (Boss creates/edits/deactivates users)
- [ ] M3 — Brands + brand assignment
- [ ] M4 — Tasks + recurring task templates (via pg_cron)
- [ ] M5 — Weekly / Bi-weekly reports workflow
- [ ] M6 — Notifications (Postgres table + Realtime + Web Push)
- [ ] M7 — Paid collab
- [ ] M8 — Client portal

## Supabase project

- URL: `https://xoaaidgvblondjpvxjqp.supabase.co`
- Anon key: lives in `.env.local` (gitignored)
