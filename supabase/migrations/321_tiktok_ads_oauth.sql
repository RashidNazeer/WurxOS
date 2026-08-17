-- ============================================================
-- WurxOS v2 — Migration 321: storage for the TikTok Business API
-- (Marketing API) advertiser OAuth handshake.
--
-- BACKGROUND. The "Wurx Ads Reporting" app (app id 7674829988993957908) was
-- approved on the TikTok for Business developer portal with five scopes:
--   Ad Account Management  → Ad Account Information   (/oauth2/advertiser/get/)
--   Reporting              → GMV Max Report           (/gmv_max/report/get/,
--                                                      /gmv_max/video_list/report/get/)
--                          → Ad Insight Report        (/report/video_performance/get/,
--                                                      /report/ad_benchmark/get/)
--   Ads Management → GMV MAX → Store Management       (/gmv_max/store/list/)
--                            → Identity And Video     (/gmv_max/video/get/)
-- Its approved redirect URL is https://wurxos.vercel.app/oauth/tiktok/callback,
-- so WurxOS is the auth broker even though the reporting UI may later live in a
-- separate product. Changing an approved redirect URL risks re-review, so this
-- is deliberate.
--
-- THE FLOW these tables serve:
--   1. A Boss/OL/ads manager clicks Connect. We mint a single-use `state` nonce
--      (tiktok_oauth_states) and send them to TikTok's portal.
--   2. TikTok bounces the advertiser back to the redirect URL with ?auth_code=…
--      &state=… The callback page hands both to the tiktok-oauth edge function.
--   3. The function validates the nonce, then trades auth_code + app secret for
--      an access token (tiktok_connections) and the advertiser ids it covers
--      (tiktok_ad_accounts).
--
-- SECURITY MODEL — the important part:
--   * tiktok_oauth_states and tiktok_connections have RLS ENABLED and ZERO
--     POLICIES. That is not an oversight. RLS with no policy denies everyone,
--     and only the service role (which bypasses RLS) can touch them. The access
--     token is a bearer credential for a client's live ad account and must
--     never be selectable from the browser, not even by the Boss.
--   * tiktok_ad_accounts holds NO secret — just advertiser id/name — so it is
--     readable by the people who need to see what is connected.
--
-- The nonce is what makes an unauthenticated callback safe: without it, anyone
-- who can POST to the callback could attach an arbitrary ad account to our
-- records. It is single-use and short-lived.
-- ============================================================

-- ── 1. CSRF / correlation nonces ─────────────────────────────────────
create table if not exists public.tiktok_oauth_states (
  state       text primary key,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  note        text
);

comment on table public.tiktok_oauth_states is
  'Single-use nonces for the TikTok advertiser OAuth handshake. Service-role only (RLS on, no policies).';

create index if not exists tiktok_oauth_states_expires_idx
  on public.tiktok_oauth_states (expires_at);

alter table public.tiktok_oauth_states enable row level security;
-- NO POLICIES ON PURPOSE. See the header.

-- ── 2. Access tokens (SECRET) ────────────────────────────────────────
create table if not exists public.tiktok_connections (
  id               uuid primary key default gen_random_uuid(),
  access_token     text not null,
  scope            jsonb,
  connected_by     uuid references public.profiles(id) on delete set null,
  connected_at     timestamptz not null default now(),
  last_verified_at timestamptz,
  last_error       text,
  revoked_at       timestamptz
);

comment on table public.tiktok_connections is
  'TikTok Business API access tokens. SERVICE-ROLE ONLY (RLS on, no policies) — a token here can read a client''s live ad spend.';
comment on column public.tiktok_connections.access_token is
  'Bearer credential. Never expose to the browser. Business API tokens are long-lived and do not auto-refresh.';

create index if not exists tiktok_connections_live_idx
  on public.tiktok_connections (connected_at desc) where revoked_at is null;

alter table public.tiktok_connections enable row level security;
-- NO POLICIES ON PURPOSE. See the header.

-- ── 3. Connected advertiser accounts (no secrets — safe to read) ─────
create table if not exists public.tiktok_ad_accounts (
  advertiser_id   text primary key,
  advertiser_name text,
  connection_id   uuid not null references public.tiktok_connections(id) on delete cascade,
  -- Which WurxOS brand this ad account belongs to. Nullable: TikTok tells us
  -- the advertiser, not our brand, so a human maps it afterwards. Reporting
  -- joins on this, so an unmapped account simply shows as unassigned rather
  -- than guessing and attributing spend to the wrong client.
  brand_id        uuid references public.brands(id) on delete set null,
  is_active       boolean not null default true,
  connected_at    timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.tiktok_ad_accounts is
  'Advertiser accounts reachable through a TikTok connection. Contains no credentials; brand_id is mapped by hand after connecting.';

create index if not exists tiktok_ad_accounts_conn_idx  on public.tiktok_ad_accounts (connection_id);
create index if not exists tiktok_ad_accounts_brand_idx on public.tiktok_ad_accounts (brand_id) where brand_id is not null;

alter table public.tiktok_ad_accounts enable row level security;

-- Read: Boss, OL and ads managers. These are the people who need to know which
-- accounts are wired up; the row carries no secret.
drop policy if exists tta_select on public.tiktok_ad_accounts;
create policy tta_select on public.tiktok_ad_accounts for select
  using (
    exists (
      select 1 from public.profiles p
       where p.id = auth.uid()
         and p.is_active = true
         and p.role in ('boss', 'ol', 'ads_manager')
    )
  );

-- Write: Boss/OL only, and in practice only to set brand_id. Everything else on
-- the row is overwritten from TikTok on the next verify, so a stray edit is
-- self-healing rather than destructive.
drop policy if exists tta_update on public.tiktok_ad_accounts;
create policy tta_update on public.tiktok_ad_accounts for update
  using (
    exists (
      select 1 from public.profiles p
       where p.id = auth.uid() and p.is_active = true and p.role in ('boss', 'ol')
    )
  )
  with check (
    exists (
      select 1 from public.profiles p
       where p.id = auth.uid() and p.is_active = true and p.role in ('boss', 'ol')
    )
  );

-- Inserts/deletes come from the edge function under the service role only —
-- no policy, so PostgREST refuses them from the browser.

-- ── Grants ───────────────────────────────────────────────────────────
-- Supabase's default privileges hand new public tables to anon/authenticated,
-- so the two secret-bearing tables get an explicit revoke. RLS-with-no-policies
-- already denies them; this is the second lock on the same door, and it makes
-- the intent obvious to whoever reads the schema next.
revoke all on public.tiktok_oauth_states from anon, authenticated;
revoke all on public.tiktok_connections  from anon, authenticated;

-- The metadata table is readable (and brand_id writable) through RLS.
revoke all on public.tiktok_ad_accounts from anon, authenticated;
grant select, update on public.tiktok_ad_accounts to authenticated;

-- ── 4. Housekeeping: drop expired nonces ─────────────────────────────
-- Called opportunistically by the edge function. Uses a WHERE clause because
-- the safeupdate guard rejects unqualified DELETE anywhere, including inside
-- SECURITY DEFINER bodies (see mig 319).
create or replace function public.tiktok_purge_expired_states()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer;
begin
  delete from public.tiktok_oauth_states
   where expires_at < now() - interval '1 day';
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Only the edge function (service role) ever calls this. Revoking from PUBLIC
-- also strips the default grant from service_role, so grant it back explicitly.
revoke all on function public.tiktok_purge_expired_states() from public, anon, authenticated;
grant execute on function public.tiktok_purge_expired_states() to service_role;
