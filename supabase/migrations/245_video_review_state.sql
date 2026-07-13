-- ============================================================
-- WurxOS v2 — Migration 245: Video Review message ledger
--
-- THE BUG THIS FIXES. video-review-targets was STATELESS: every run recomputed
-- each creator's send dates from their video dates and emitted only those whose
-- due date equalled the target EXACTLY. A target date is processed once and
-- never revisited. So if Euka had not yet ingested a creator's video on the day
-- we processed it, that creator was missed — PERMANENTLY. No missed-date entry
-- could recover them, because from the tool's point of view that day was done.
--
-- This is not hypothetical. Euka's ingestion for the Cutler store lags well past
-- the 3-day buffer we run on (Jul 10 was still at 69 of ~150 videos four days
-- later), and TikTok showed creators — sammyyc1, kelliward10, morsekyle's Jul 10
-- video — that Euka simply did not have. Every one of them would never have been
-- messaged.
--
-- THE FIX. Give the tool a memory. This table records, per brand per creator,
-- the videos we know about and how many of the three review messages have
-- actually been sent. The run then asks "what does this creator still OWE?"
-- rather than "is something due exactly today?", and fires any message whose due
-- date is on or BEFORE the target. A late-arriving video therefore produces a
-- catch-up message on the next run instead of vanishing. Euka lag degrades from
-- silent data loss to mere delay.
--
-- The ledger also makes the run CHEAPER, not dearer. Today every run re-walks
-- each creator's full history from Euka (a 379-video creator costs 10 API calls
-- to prove they are not due). Here each creator is deep-walked ONCE, ever;
-- afterwards their state is refreshed from the single window fetch the run
-- already makes. Creators who have had all 3 messages are skipped on a DB lookup
-- with zero Euka calls. That is what pays for widening the lookback from 3 days
-- to 14 (306 candidates instead of 26) — without which a late video is invisible
-- no matter how good the logic.
--
-- RULES ENCODED HERE (confirmed with the Boss):
--   * A creator receives AT MOST 3 messages, ever: 1st / 2nd / 3rd video review.
--   * Messages track VIDEOS: 1 video = 1 message. 10 videos on one day still
--     means 3 messages — delivered on 3 SEPARATE days, in sequence.
--   * msgs_sent is the cap, not the video count. A 4th, 10th, 100th video
--     triggers nothing once 3 messages have gone out.
-- ============================================================

create table if not exists public.video_review_state (
  brand_id       uuid not null references public.brands(id) on delete cascade,
  creator_handle text not null,

  -- The creator's video posting days, oldest first, ONE ENTRY PER VIDEO (three
  -- videos on the same day are three entries — that is exactly what makes them
  -- three messages on three days). We only ever need the first three, so this is
  -- capped at 3 on write.
  video_days     date[] not null default '{}',

  -- Total videos we have seen (uncapped) — for the info panel only.
  video_count    int  not null default 0,

  -- How many of the 3 review messages have ACTUALLY been sent. This is the cap.
  msgs_sent      int  not null default 0 check (msgs_sent between 0 and 3),
  last_sent_on   date,
  msg1_on        date,
  msg2_on        date,
  msg3_on        date,

  -- 'run'  — recorded by a real run + CSV download
  -- 'seed' — backfilled as already-handled by the pre-cutoff seed (the team was
  --          doing this by hand before the ledger existed)
  source         text not null default 'run' check (source in ('run', 'seed')),

  -- When we last did the expensive full-history walk. Set => never walk again.
  walked_at      timestamptz,
  updated_at     timestamptz not null default now(),

  primary key (brand_id, creator_handle)
);

create index if not exists vrs_brand_idx on public.video_review_state(brand_id);
create index if not exists vrs_owing_idx on public.video_review_state(brand_id, msgs_sent)
  where msgs_sent < 3;

alter table public.video_review_state enable row level security;

-- The edge function writes with the service role (bypasses RLS). These policies
-- exist so the ledger is READABLE for support/debugging by the people who can
-- already see the brand — never writable from the browser.
drop policy if exists vrs_select on public.video_review_state;
create policy vrs_select on public.video_review_state for select
  using (
    public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p
                where p.id = auth.uid() and p.role in ('ol', 'tl'))
    or exists (select 1 from public.brand_assignments ba
                where ba.brand_id = video_review_state.brand_id
                  and ba.user_id = auth.uid())
  );

-- ── Idempotent recorder ───────────────────────────────────────
-- Called from the browser when the APC DOWNLOADS a group's CSV — that is the
-- commitment point (the file goes straight up to Euka, so the messages go out).
--
-- SECURITY DEFINER because the table is service-role-write only, so the authz
-- check lives HERE: the caller must be an APC actually assigned to the brand,
-- exactly like the edge function. Video Reviews is APC-only.
--
-- greatest() everywhere, so downloading the same CSV twice can never
-- double-advance a creator, and an out-of-order call can never walk the counter
-- backwards. Sending the same message twice is far less harmful than skipping
-- one, but neither should be possible.
create or replace function public.video_review_mark_sent(
  p_brand    uuid,
  p_handles  text[],
  p_msg_no   int,
  p_sent_on  date
) returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_n   int  := 0;
begin
  if p_msg_no not between 1 and 3 then
    raise exception 'message number must be 1..3 (got %)', p_msg_no;
  end if;

  if not exists (
    select 1
      from public.profiles p
      join public.brand_assignments ba
        on ba.user_id = p.id and ba.brand_id = p_brand
     where p.id = v_uid
       and p.role = 'apc'
       and p.is_active is true
  ) then
    raise exception 'forbidden — Video Reviews is for APCs assigned to this brand';
  end if;

  update public.video_review_state s
     set msgs_sent    = greatest(s.msgs_sent, p_msg_no),
         last_sent_on = greatest(coalesce(s.last_sent_on, p_sent_on), p_sent_on),
         msg1_on      = case when p_msg_no = 1 then coalesce(s.msg1_on, p_sent_on) else s.msg1_on end,
         msg2_on      = case when p_msg_no = 2 then coalesce(s.msg2_on, p_sent_on) else s.msg2_on end,
         msg3_on      = case when p_msg_no = 3 then coalesce(s.msg3_on, p_sent_on) else s.msg3_on end,
         updated_at   = now()
   where s.brand_id = p_brand
     and s.creator_handle = any(p_handles);

  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.video_review_mark_sent(uuid, text[], int, date) from public, anon;
grant execute on function public.video_review_mark_sent(uuid, text[], int, date) to authenticated;
