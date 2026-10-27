create table if not exists public."جلسات الحضور" (
  session_id text primary key,
  session_key text not null,
  "المادة" text not null,
  "الفئة" text not null,
  "المشرف" text not null,
  student_year text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  challenge_token text,
  challenge_expires_at timestamptz,
  challenge_frequency_hz integer,
  "الحالة" text not null default 'نشطة'
);

alter table public."جلسات الحضور"
  add column if not exists student_year text,
  add column if not exists challenge_token text,
  add column if not exists challenge_expires_at timestamptz,
  add column if not exists challenge_frequency_hz integer;

alter table public."الحضور"
  add column if not exists session_id text;

alter table public."الإنذارات"
  add column if not exists session_id text;

create index if not exists attendance_session_id_idx
  on public."الحضور" (session_id)
  where session_id is not null;

create index if not exists warnings_session_id_idx
  on public."الإنذارات" (session_id)
  where session_id is not null;

drop index if exists public.attendance_active_session_key;

alter table public."جلسات الحضور" enable row level security;

drop policy if exists "attendance sessions can be read" on public."جلسات الحضور";
create policy "attendance sessions can be read"
  on public."جلسات الحضور"
  for select
  to anon, authenticated
  using (true);

drop policy if exists "attendance sessions can be created" on public."جلسات الحضور";
create policy "attendance sessions can be created"
  on public."جلسات الحضور"
  for insert
  to anon, authenticated
  with check (true);

drop policy if exists "attendance sessions can be closed" on public."جلسات الحضور";
create policy "attendance sessions can be closed"
  on public."جلسات الحضور"
  for update
  to anon, authenticated
  using (true)
  with check (true);

create or replace function public.delete_attendance_session(p_session_id text)
returns table (deleted_attendance integer, deleted_warnings integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  session_status text;
  session_ended_at timestamptz;
begin
  select "الحالة", ended_at
    into session_status, session_ended_at
    from public."جلسات الحضور"
    where session_id = p_session_id
    for update;

  if not found then
    raise exception 'attendance_session_not_found' using errcode = 'P0002';
  end if;

  if session_status = 'نشطة' or session_ended_at is null then
    raise exception 'attendance_session_active' using errcode = '55000';
  end if;

  delete from public."الحضور" where session_id = p_session_id;
  get diagnostics deleted_attendance = row_count;

  delete from public."الإنذارات" where session_id = p_session_id;
  get diagnostics deleted_warnings = row_count;

  delete from public."جلسات الحضور" where session_id = p_session_id;
  return next;
end;
$$;

revoke all on function public.delete_attendance_session(text) from public, anon, authenticated;
grant execute on function public.delete_attendance_session(text) to service_role;
