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
