-- ============================================================
-- Migration 066 — Broadcasts: v1 parity
--
-- v1 rule: Boss and OL broadcast to anyone (all / roles / brand /
-- specific users). TL broadcasts to their direct-report team or
-- specific users. APC/IPC never compose (receive-only).
--
-- Changes vs 034:
--   * `target` widened: 'all' | 'role' | 'brand' | 'users' | 'my_team'
--   * `target_user_ids uuid[]` added — specific users picker
--   * INSERT RLS expanded to TL and PCTL
--   * dispatch_broadcast() teaches 'users' and 'my_team' (reports_to)
--   * Sender-scope guard: TL/PCTL can only choose 'users' or 'my_team'
--     (not 'all' or 'role'); Boss/OL can choose anything.
-- ============================================================

alter table public.broadcasts
  add column if not exists target_user_ids uuid[] not null default '{}';

-- Widen the target check
do $$
begin
  begin
    alter table public.broadcasts drop constraint if exists broadcasts_target_check;
  exception when undefined_object then null;
  end;
  alter table public.broadcasts
    add constraint broadcasts_target_check
    check (target in ('all','role','brand','users','my_team'));
end $$;

-- --------------------------------------------------------------
-- INSERT RLS — allow boss, ol, developer, tl, pctl
-- --------------------------------------------------------------
drop policy if exists "bc_insert" on public.broadcasts;
create policy "bc_insert"
  on public.broadcasts for insert
  with check (
    author_id = auth.uid()
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.is_active = true
        and p.role in ('boss','ol','developer','tl','pctl')
    )
    -- TL/PCTL can only send to 'users' or 'my_team' — never 'all' or 'role' or 'brand'
    and (
      exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('boss','ol','developer'))
      or target in ('users','my_team')
    )
  );

-- Broaden SELECT so recipients can read their broadcasts (via notifications UI).
-- Notifications already link to the broadcast; we let authenticated users read
-- any broadcast record they can point to.
drop policy if exists "bc_select" on public.broadcasts;
create policy "bc_select"
  on public.broadcasts for select
  using (auth.uid() is not null);

-- --------------------------------------------------------------
-- Dispatch: teach it 'users' and 'my_team'
-- --------------------------------------------------------------
create or replace function public.dispatch_broadcast(p_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.broadcasts;
  v_uid uuid;
  v_count int := 0;
begin
  select * into v_row from public.broadcasts where id = p_id;
  if not found or v_row.sent_at is not null then return 0; end if;

  for v_uid in
    select p.id from public.profiles p
    where p.is_active = true
      and (
        v_row.target = 'all'
        or (v_row.target = 'role'    and p.role = any (v_row.target_roles))
        or (v_row.target = 'users'   and p.id  = any (v_row.target_user_ids))
        or (v_row.target = 'my_team' and p.reports_to = v_row.author_id)
        or (v_row.target = 'brand'   and (
              p.id = (select owner_id from public.brands where id = v_row.target_brand_id)
              or exists (
                select 1 from public.brand_assignments ba
                where ba.brand_id = v_row.target_brand_id and ba.user_id = p.id
              )
            ))
      )
      and p.id <> coalesce(v_row.author_id, '00000000-0000-0000-0000-000000000000'::uuid)
  loop
    perform public.emit_notification(
      v_uid, v_row.author_id, 'system', 'broadcast',
      v_row.title, v_row.body, 'broadcast', v_row.id, '/broadcasts'
    );
    v_count := v_count + 1;
  end loop;

  update public.broadcasts set sent_at = now(), sent_count = v_count where id = p_id;
  return v_count;
end;
$$;
