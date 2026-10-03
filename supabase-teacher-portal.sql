alter table public.teachers
  add column if not exists login_username text,
  add column if not exists password_hash text;

create unique index if not exists teachers_login_username_lower_idx
  on public.teachers (lower(login_username))
  where login_username is not null;

create table if not exists public.teacher_alerts (
  id bigint generated always as identity primary key,
  teacher_id uuid not null references public.teachers(id) on delete cascade,
  teacher_name text not null,
  student_id text not null,
  student_name text not null default '',
  subject text not null,
  message text not null check (char_length(message) between 3 and 1000),
  created_at timestamptz not null default now()
);

create index if not exists teacher_alerts_student_created_idx
  on public.teacher_alerts (student_id, created_at desc);

create index if not exists teacher_alerts_teacher_subject_idx
  on public.teacher_alerts (teacher_id, subject);

alter table public.teacher_alerts enable row level security;
revoke all on public.teacher_alerts from anon, authenticated;
grant all on public.teacher_alerts to service_role;
grant usage, select on sequence public.teacher_alerts_id_seq to service_role;

alter table public.teachers enable row level security;
revoke all on public.teachers from anon, authenticated;
grant all on public.teachers to service_role;
