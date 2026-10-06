create table if not exists public.student_feedback (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('complaint', 'suggestion')),
  category text not null,
  details text not null check (char_length(btrim(details)) between 1 and 3000),
  student_id text not null check (char_length(student_id) between 1 and 80),
  student_name text not null check (char_length(student_name) between 1 and 240),
  created_at timestamptz not null default now()
);

do $$
declare
  constraint_row record;
begin
  for constraint_row in
    select conname
    from pg_constraint
    where conrelid = 'public.student_feedback'::regclass
      and contype = 'c'
  loop
    execute format(
      'alter table public.student_feedback drop constraint %I',
      constraint_row.conname
    );
  end loop;
end $$;

create index if not exists student_feedback_created_at_idx
  on public.student_feedback (created_at desc);

create index if not exists student_feedback_student_id_idx
  on public.student_feedback (student_id);

alter table public.student_feedback disable row level security;
revoke all on public.student_feedback from anon, authenticated;
grant all on public.student_feedback to service_role;

select
  c.relrowsecurity as rls_enabled,
  count(pc.oid) filter (where pc.contype = 'c') as remaining_check_constraints
from pg_class c
left join pg_constraint pc on pc.conrelid = c.oid
where c.oid = 'public.student_feedback'::regclass
group by c.relrowsecurity;
