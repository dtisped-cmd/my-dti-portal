begin;

lock table public.students in access exclusive mode;

create sequence if not exists public.students_num_seq;

select setval(
  'public.students_num_seq',
  coalesce((select max(num) from public.students), 0) + 1,
  false
);

alter table public.students
  alter column num set default nextval('public.students_num_seq');

alter sequence public.students_num_seq
  owned by public.students.num;

commit;
