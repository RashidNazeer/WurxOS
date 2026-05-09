-- ============================================================
-- Migration 118 — Manager force-close for stuck attendance
--
-- After migration 117 retired hard auto-close, sessions can sit
-- open indefinitely if the user never returns to use the recovery
-- prompt. This gives Boss/OL/Developer a direct override they can
-- apply from the Team history view: pick a clock-out time, attach
-- an optional reason, and close the session with audit + notif.
--
-- The TL approval flow for self-submitted recoveries is untouched
-- (att_request_edit) — this is the leadership escape hatch.
-- ============================================================

alter table public.attendance
  add column if not exists closed_by_manager_id   uuid references public.profiles(id),
  add column if not exists closed_by_manager_role text,
  add column if not exists closed_by_reason       text,
  add column if not exists closed_by_at           timestamptz;

create or replace function public.att_force_close(
  p_attendance_id uuid,
  p_clock_out     timestamptz,
  p_reason        text default null
)
returns public.attendance
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid       uuid := auth.uid();
  v_role      text;
  v_row       public.attendance;
  v_breaks    jsonb;
  v_last      jsonb;
  v_last_start timestamptz;
  v_last_end   timestamptz;
  v_extra_ms  int;
  v_total_br  int;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;

  select role into v_role from public.profiles where id = v_uid;
  if v_role not in ('boss','ol','developer') then
    raise exception 'only Boss / OL / Developer can force-close sessions';
  end if;

  select * into v_row from public.attendance where id = p_attendance_id for update;
  if not found then raise exception 'attendance row not found'; end if;

  if v_row.clock_out is not null and v_row.status = 'clocked-out' then
    -- Already closed — idempotent return.
    return v_row;
  end if;

  if p_clock_out is null then raise exception 'clock_out timestamp required'; end if;
  if p_clock_out <= v_row.clock_in then
    raise exception 'clock_out must be after clock_in';
  end if;
  if p_clock_out > v_row.clock_in + interval '16 hours' then
    raise exception 'clock_out cannot be more than 16 hours after clock_in';
  end if;
  if p_clock_out > now() then
    raise exception 'clock_out cannot be in the future';
  end if;

  -- Close any still-open break at the new clock-out moment so its
  -- duration is accounted for in total_break_ms.
  v_breaks   := coalesce(v_row.breaks, '[]'::jsonb);
  v_total_br := coalesce(v_row.total_break_ms, 0);
  v_extra_ms := 0;

  if v_row.status = 'on-break' and jsonb_array_length(v_breaks) > 0 then
    v_last       := v_breaks -> (jsonb_array_length(v_breaks) - 1);
    v_last_start := nullif(v_last ->> 'start', '')::timestamptz;
    v_last_end   := nullif(v_last ->> 'end',   '')::timestamptz;
    if v_last_start is not null and v_last_end is null then
      -- Cap the open break at the new clock-out so it can't extend past it.
      v_last_end := greatest(v_last_start, p_clock_out);
      v_extra_ms := greatest(0, extract(epoch from (v_last_end - v_last_start))::int * 1000);
      v_breaks := jsonb_set(
        v_breaks,
        array[(jsonb_array_length(v_breaks) - 1)::text],
        v_last || jsonb_build_object('end', v_last_end, 'force_closed', true)
      );
      v_total_br := v_total_br + v_extra_ms;
    end if;
  end if;

  update public.attendance
     set status                  = 'clocked-out',
         clock_out               = p_clock_out,
         breaks                  = v_breaks,
         total_break_ms          = v_total_br,
         total_work_ms           = greatest(
                                     0,
                                     extract(epoch from (p_clock_out - clock_in))::int * 1000
                                     - v_total_br
                                   ),
         auto_closed             = false,
         closed_by_manager_id    = v_uid,
         closed_by_manager_role  = v_role,
         closed_by_reason        = nullif(trim(coalesce(p_reason, '')), ''),
         closed_by_at            = now()
   where id = p_attendance_id
   returning * into v_row;

  -- Notify the user that their session was closed for them. The
  -- emit_notification helper drops self-notifies (recipient = actor).
  perform public.emit_notification(
    v_row.user_id,
    v_uid,
    'attendance',
    'attendance.force_close',
    'Your session was closed by a manager',
    coalesce(
      nullif(trim(coalesce(p_reason, '')), ''),
      'Your open shift on ' || to_char(v_row.date, 'Mon FMDD') ||
      ' was force-closed at ' || to_char(p_clock_out, 'HH24:MI') || '.'
    ),
    'attendance',
    v_row.id,
    '/attendance'
  );

  return v_row;
end;
$$;

grant execute on function public.att_force_close(uuid, timestamptz, text) to authenticated;
