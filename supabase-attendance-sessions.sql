create table if not exists public."جلسات الحضور" (
  session_id text primary key,
  session_key text not null,
  "المادة" text not null,
  "الفئة" text not null,
  "المشرف" text not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  "الحالة" text not null default 'نشطة'
);

drop index if exists public.attendance_active_session_key;

alter table public."جلسات الحضور" enable row level security;

create policy "attendance sessions can be read"
  on public."جلسات الحضور"
  for select
  to anon, authenticated
  using (true);

create policy "attendance sessions can be created"
  on public."جلسات الحضور"
  for insert
  to anon, authenticated
  with check (true);

create policy "attendance sessions can be closed"
  on public."جلسات الحضور"
  for update
  to anon, authenticated
  using (true)
  with check (true);
