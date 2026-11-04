-- ============================================================
-- WurxOS v2 — Migration 436: the Claude connector's own sign-in layer.
--
-- The `mcp` edge function issues its OWN opaque tokens (OAuth 2.1 authorization code + PKCE) that work only at
-- /mcp. Nothing here is a Supabase session, so a connector token cannot be used against the database API, Auth or
-- any other function. Only hashes of codes and tokens are stored.
--
-- Everything is service-role only: RLS is on with NO policies, table privileges are revoked from anon and
-- authenticated, and the SQL functions that touch these tables are executable by service_role alone, except the
-- three Boss-only management functions at the end. Idempotent.
-- ============================================================

create table if not exists public.mcp_oauth_clients (
  client_id     text primary key,
  client_name   text not null,
  redirect_uris text[] not null,
  created_at    timestamptz not null default now()
);

create table if not exists public.mcp_oauth_requests (          -- an /authorize call waiting for the person's decision
  id_hash        text primary key,
  client_id      text not null references public.mcp_oauth_clients(client_id) on delete cascade,
  redirect_uri   text not null,
  state          text,
  code_challenge text not null,
  resource       text not null,
  user_id        uuid,
  decided_at     timestamptz,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null
);

create table if not exists public.mcp_oauth_codes (            -- single-use authorization codes (60 s)
  code_hash      text primary key,
  client_id      text not null references public.mcp_oauth_clients(client_id) on delete cascade,
  user_id        uuid not null references public.profiles(id) on delete cascade,
  redirect_uri   text not null,
  code_challenge text not null,
  resource       text not null,
  used_at        timestamptz,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null
);

create table if not exists public.mcp_oauth_tokens (            -- one row per access+refresh pair; a family = one connection
  id                 bigint generated always as identity primary key,
  family_id          uuid not null,
  user_id            uuid not null references public.profiles(id) on delete cascade,
  client_id          text not null references public.mcp_oauth_clients(client_id) on delete cascade,
  resource           text not null,
  code_hash          text,
  access_hash        text not null unique,
  access_expires_at  timestamptz not null,
  refresh_hash       text not null unique,
  refresh_expires_at timestamptz not null,
  refresh_used_at    timestamptz,
  revoked_at         timestamptz,
  created_at         timestamptz not null default now(),
  last_used_at       timestamptz
);
create index if not exists mcp_oauth_tokens_user_idx   on public.mcp_oauth_tokens (user_id) where revoked_at is null;
create index if not exists mcp_oauth_tokens_family_idx on public.mcp_oauth_tokens (family_id);
create index if not exists mcp_oauth_clients_created_idx on public.mcp_oauth_clients (created_at);

alter table public.mcp_oauth_clients  enable row level security;
alter table public.mcp_oauth_requests enable row level security;
alter table public.mcp_oauth_codes    enable row level security;
alter table public.mcp_oauth_tokens   enable row level security;
revoke all on table public.mcp_oauth_clients, public.mcp_oauth_requests, public.mcp_oauth_codes, public.mcp_oauth_tokens from anon, authenticated;

-- A code is spent exactly once. Presenting a spent code again revokes everything that code produced.
create or replace function public.mcp_oauth_consume_code(p_hash text)
 returns table(client_id text, user_id uuid, redirect_uri text, code_challenge text, resource text)
 language plpgsql security definer set search_path = public
as $$
begin
  return query
    update public.mcp_oauth_codes c set used_at = now()
     where c.code_hash = p_hash and c.used_at is null and c.expires_at > now()
    returning c.client_id, c.user_id, c.redirect_uri, c.code_challenge, c.resource;
  if not found then
    update public.mcp_oauth_tokens t set revoked_at = now() where t.code_hash = p_hash and t.revoked_at is null;
  end if;
end;
$$;

-- Refresh-token rotation. Returns the person and family on success, nothing otherwise. Reusing an already
-- rotated refresh token is treated as theft: the whole family is revoked.
create or replace function public.mcp_oauth_rotate(p_old text, p_client text, p_new_access text, p_new_refresh text,
                                                   p_access_exp timestamptz, p_refresh_exp timestamptz)
 returns table(user_id uuid, family_id uuid, resource text)
 language plpgsql security definer set search_path = public
as $$
declare t public.mcp_oauth_tokens;
begin
  select * into t from public.mcp_oauth_tokens x where x.refresh_hash = p_old for update;
  if not found or t.client_id <> p_client then return; end if;
  if t.refresh_used_at is not null then
    update public.mcp_oauth_tokens x set revoked_at = now() where x.family_id = t.family_id and x.revoked_at is null;
    return;
  end if;
  if t.revoked_at is not null or t.refresh_expires_at <= now() then return; end if;
  update public.mcp_oauth_tokens x set refresh_used_at = now(), revoked_at = now() where x.id = t.id;
  insert into public.mcp_oauth_tokens (family_id, user_id, client_id, resource, code_hash, access_hash, access_expires_at, refresh_hash, refresh_expires_at)
  values (t.family_id, t.user_id, t.client_id, t.resource, t.code_hash, p_new_access, p_access_exp, p_new_refresh, p_refresh_exp);
  return query select t.user_id, t.family_id, t.resource;
end;
$$;

-- RFC 7009: revoking either token of a pair ends the whole connection.
create or replace function public.mcp_oauth_revoke(p_hash text)
 returns void language sql security definer set search_path = public
as $$
  update public.mcp_oauth_tokens x set revoked_at = now()
   where x.revoked_at is null
     and x.family_id in (select family_id from public.mcp_oauth_tokens where access_hash = p_hash or refresh_hash = p_hash);
$$;

-- Housekeeping, called now and then by the function (no cron job on purpose).
create or replace function public.mcp_oauth_cleanup()
 returns void language sql security definer set search_path = public
as $$
  delete from public.mcp_oauth_requests where expires_at < now() - interval '1 hour';
  delete from public.mcp_oauth_codes    where expires_at < now() - interval '1 hour';
  delete from public.mcp_oauth_tokens   where refresh_expires_at < now() - interval '7 days' or revoked_at < now() - interval '30 days';
  delete from public.mcp_oauth_clients c
   where c.created_at < now() - interval '1 day'
     and not exists (select 1 from public.mcp_oauth_tokens t where t.client_id = c.client_id);
$$;

revoke execute on function public.mcp_oauth_consume_code(text), public.mcp_oauth_rotate(text, text, text, text, timestamptz, timestamptz),
  public.mcp_oauth_revoke(text), public.mcp_oauth_cleanup() from public, anon, authenticated;
grant execute on function public.mcp_oauth_consume_code(text), public.mcp_oauth_rotate(text, text, text, text, timestamptz, timestamptz),
  public.mcp_oauth_revoke(text), public.mcp_oauth_cleanup() to service_role;

-- ---- Boss controls ----------------------------------------------------------------------------
create or replace function public.mcp_connections()
 returns table(family_id uuid, user_id uuid, display_name text, role text, client_name text, connected_at timestamptz, last_used_at timestamptz)
 language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_boss(auth.uid()) then raise exception 'only the Boss can see connections'; end if;
  return query
    select t.family_id, t.user_id, p.display_name, p.role, c.client_name, min(t.created_at), max(t.last_used_at)
      from public.mcp_oauth_tokens t
      join public.profiles p on p.id = t.user_id
      join public.mcp_oauth_clients c on c.client_id = t.client_id
     where t.revoked_at is null and t.refresh_expires_at > now()
     group by t.family_id, t.user_id, p.display_name, p.role, c.client_name
     order by max(t.created_at) desc;
end;
$$;

create or replace function public.mcp_revoke_connection(p_family uuid)
 returns void language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_boss(auth.uid()) then raise exception 'only the Boss can revoke connections'; end if;
  update public.mcp_oauth_tokens set revoked_at = now() where family_id = p_family and revoked_at is null;
end;
$$;

-- The kill switch: every connection stops at once (the function also honours app_config.mcp_enabled = 'false').
create or replace function public.mcp_revoke_all()
 returns integer language plpgsql security definer set search_path = public
as $$
declare n integer;
begin
  if not public.is_boss(auth.uid()) then raise exception 'only the Boss can revoke connections'; end if;
  update public.mcp_oauth_tokens set revoked_at = now() where revoked_at is null;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke execute on function public.mcp_connections(), public.mcp_revoke_connection(uuid), public.mcp_revoke_all() from public, anon;
grant execute on function public.mcp_connections(), public.mcp_revoke_connection(uuid), public.mcp_revoke_all() to authenticated, service_role;

do $verify$
declare t text;
begin
  foreach t in array array['mcp_oauth_clients', 'mcp_oauth_requests', 'mcp_oauth_codes', 'mcp_oauth_tokens'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then raise exception 'mig 436: RLS is off on %', t; end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t) then raise exception 'mig 436: % must have no policies', t; end if;
    if has_table_privilege('authenticated', 'public.' || t, 'select') or has_table_privilege('anon', 'public.' || t, 'select') then raise exception 'mig 436: % is readable by clients', t; end if;
  end loop;
  if has_function_privilege('authenticated', 'public.mcp_oauth_consume_code(text)', 'execute')
     or has_function_privilege('anon', 'public.mcp_oauth_rotate(text,text,text,text,timestamptz,timestamptz)', 'execute') then
    raise exception 'mig 436: token functions must be service-role only';
  end if;
end;
$verify$;
