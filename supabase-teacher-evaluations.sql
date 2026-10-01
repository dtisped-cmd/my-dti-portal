create table if not exists public.teachers (
  id uuid primary key default gen_random_uuid(),
  teacher_name text not null,
  subjects text[] not null default '{}',
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.portal_feature_settings (
  feature_key text primary key,
  enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

insert into public.portal_feature_settings (feature_key, enabled)
values ('teacher_evaluation', false)
on conflict (feature_key) do nothing;

create table if not exists public.teacher_evaluations (
  id bigint generated always as identity primary key,
  student_id text not null,
  student_name text not null default '',
  teacher_id uuid not null references public.teachers(id) on delete cascade,
  subject text not null,
  rating smallint not null check (rating between 0 and 4),
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint teacher_evaluations_one_per_student_subject
    unique (student_id, teacher_id, subject)
);

alter table public.teacher_evaluations
  add column if not exists student_name text not null default '',
  add column if not exists note text not null default '';

alter table public.teacher_evaluations
  drop constraint if exists teacher_evaluations_rating_check;

alter table public.teacher_evaluations
  add constraint teacher_evaluations_rating_check check (rating between 0 and 4);

create index if not exists teacher_evaluations_teacher_subject_idx
  on public.teacher_evaluations (teacher_id, subject);

alter table public.teachers enable row level security;
alter table public.portal_feature_settings enable row level security;
alter table public.teacher_evaluations enable row level security;

drop policy if exists "teachers can be viewed" on public.teachers;
drop policy if exists "feature settings can be viewed" on public.portal_feature_settings;
drop policy if exists "feature settings can be created" on public.portal_feature_settings;
drop policy if exists "feature settings can be updated" on public.portal_feature_settings;
drop policy if exists "teacher evaluations can be viewed" on public.teacher_evaluations;
drop policy if exists "teacher evaluations can be created" on public.teacher_evaluations;
drop policy if exists "teacher evaluations can be updated" on public.teacher_evaluations;

revoke all on public.teachers from anon, authenticated;
revoke all on public.portal_feature_settings from anon, authenticated;
revoke all on public.teacher_evaluations from anon, authenticated;

grant all on public.teachers to service_role;
grant all on public.portal_feature_settings to service_role;
grant all on public.teacher_evaluations to service_role;
grant usage, select on sequence public.teacher_evaluations_id_seq to service_role;

-- Add teacher records from the Supabase SQL Editor, for example:
-- insert into public.teachers (teacher_name, subjects)
-- values ('اسم المدرس', array['اسم المقرر الأول', 'اسم المقرر الثاني']);
