create table if not exists public.teachers (
  id uuid primary key default gen_random_uuid(),
  teacher_name text not null,
  subjects text[] not null default '{}',
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.teachers
  add column if not exists login_username text,
  add column if not exists password_hash text;

create unique index if not exists teachers_login_username_lower_idx
  on public.teachers (lower(login_username))
  where login_username is not null;

create table if not exists public.student_classes (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  student_year text not null check (student_year in ('أولى', 'ثانية')),
  capacity integer check (capacity is null or capacity >= 0),
  occupied integer not null default 0 check (occupied >= 0),
  available_seats integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint student_classes_year_name_unique unique (student_year, name)
);

alter table public.student_classes enable row level security;
revoke all on public.student_classes from anon, authenticated;
grant all on public.student_classes to service_role;

drop policy if exists "students can view academic classes" on public.student_classes;

create table if not exists public.academic_subjects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  student_year text not null check (student_year in ('أولى', 'ثانية')),
  teacher_id uuid not null references public.teachers(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint academic_subjects_year_name_unique unique (student_year, name)
);

create index if not exists academic_subjects_teacher_year_idx
  on public.academic_subjects (teacher_id, student_year);

alter table public.academic_subjects enable row level security;
revoke all on public.academic_subjects from anon, authenticated;
grant all on public.academic_subjects to service_role;

alter table public.schedule_items
  add column if not exists student_year text,
  add column if not exists teacher_id uuid references public.teachers(id) on delete set null;

create index if not exists schedule_items_year_group_day_time_idx
  on public.schedule_items (student_year, group_name, day, start_time);

grant all on public.schedule_items to service_role;
revoke all on public.schedule_items from anon, authenticated;

alter table public.teacher_alerts
  add column if not exists student_year text;

grant all on public.teachers to service_role;
