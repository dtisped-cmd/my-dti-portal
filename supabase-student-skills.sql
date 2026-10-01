create table if not exists public.student_skills (
  student_id text primary key,
  name text not null default '',
  phone text not null default '',
  skills jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  constraint student_skills_max_three
    check (jsonb_typeof(skills) = 'array' and jsonb_array_length(skills) <= 3)
);

alter table public.student_skills
  add column if not exists name text not null default '',
  add column if not exists phone text not null default '';

alter table public.student_skills enable row level security;

drop policy if exists "student skills can be read" on public.student_skills;
create policy "student skills can be read"
  on public.student_skills
  for select
  to anon, authenticated
  using (true);

drop policy if exists "student skills can be created" on public.student_skills;
create policy "student skills can be created"
  on public.student_skills
  for insert
  to anon, authenticated
  with check (true);

drop policy if exists "student skills can be updated" on public.student_skills;
create policy "student skills can be updated"
  on public.student_skills
  for update
  to anon, authenticated
  using (true)
  with check (true);

grant select, insert, update on public.student_skills to anon, authenticated;