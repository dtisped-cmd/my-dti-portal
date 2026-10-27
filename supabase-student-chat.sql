create table if not exists public.student_chat_settings (
  id smallint primary key check (id = 1),
  is_open boolean not null default true,
  is_open_first boolean not null default true,
  is_open_second boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by text
);

alter table public.student_chat_settings
  add column if not exists is_open_first boolean not null default true,
  add column if not exists is_open_second boolean not null default true;

insert into public.student_chat_settings (id, is_open)
values (1, true)
on conflict (id) do nothing;

create table if not exists public.student_chat_messages (
  id uuid primary key default gen_random_uuid(),
  student_id text not null check (char_length(btrim(student_id)) between 1 and 80),
  student_name text not null check (char_length(btrim(student_name)) between 1 and 240),
  student_year text check (student_year is null or student_year in ('أولى', 'ثانية')),
  message text not null default '',
  attachment_name text,
  attachment_type text,
  attachment_size integer,
  created_at timestamptz not null default now(),
  edited_at timestamptz
);

alter table public.student_chat_messages
  add column if not exists student_year text,
  add column if not exists attachment_name text,
  add column if not exists attachment_type text,
  add column if not exists attachment_size integer,
  add column if not exists edited_at timestamptz,
  alter column message set default '';

update public.student_chat_messages as messages
set student_year = case
  when students.year_value in ('1', '١')
    or students.year_value like '%اولى%'
    or students.year_value like '%أولى%'
    or students.year_value like '%first%'
  then 'أولى'
  when students.year_value in ('2', '٢')
    or students.year_value like '%ثانية%'
    or students.year_value like '%second%'
  then 'ثانية'
  else null
end
from (
  select
    coalesce(
      to_jsonb(student)->>'الرقم الجامعي',
      to_jsonb(student)->>'student_id',
      to_jsonb(student)->>'studentId',
      to_jsonb(student)->>'id'
    ) as student_id,
    lower(regexp_replace(coalesce(
      to_jsonb(student)->>'السنه الدراسية',
      to_jsonb(student)->>'السنة الدراسية',
      to_jsonb(student)->>'year',
      to_jsonb(student)->>'student_year'
    ), '\s+', '', 'g')) as year_value
  from public.students as student
) as students
where messages.student_year is null
  and students.student_id = messages.student_id;

alter table public.student_chat_messages
  drop constraint if exists student_chat_messages_student_year_check;

alter table public.student_chat_messages
  add constraint student_chat_messages_student_year_check
  check (student_year is null or student_year in ('أولى', 'ثانية'));

alter table public.student_chat_messages
  drop constraint if exists student_chat_messages_message_check;

alter table public.student_chat_messages
  add constraint student_chat_messages_message_check
  check (
    (char_length(btrim(message)) between 1 and 1000)
    or (
      nullif(btrim(attachment_name), '') is not null
      and attachment_type in ('image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf', 'text/plain')
      and attachment_size between 1 and 1048576
    )
  );

create index if not exists student_chat_messages_created_at_idx
  on public.student_chat_messages (created_at desc);

create index if not exists student_chat_messages_year_created_at_idx
  on public.student_chat_messages (student_year, created_at desc);

create table if not exists public.student_chat_attachments (
  message_id uuid primary key references public.student_chat_messages(id) on delete cascade,
  data_base64 text not null
);

create table if not exists public.student_chat_message_reads (
  message_id uuid not null references public.student_chat_messages(id) on delete cascade,
  student_id text not null check (char_length(btrim(student_id)) between 1 and 80),
  read_at timestamptz not null default now(),
  primary key (message_id, student_id)
);

create index if not exists student_chat_message_reads_student_id_idx
  on public.student_chat_message_reads (student_id);

create or replace function public.student_chat_read_counts(p_message_ids uuid[])
returns table (message_id uuid, viewer_count bigint)
language sql
stable
security definer
set search_path = public
as $$
  select
    requested.message_id,
    count(distinct reads.student_id) filter (where reads.student_id <> messages.student_id) as viewer_count
  from unnest(p_message_ids) as requested(message_id)
  left join public.student_chat_messages as messages on messages.id = requested.message_id
  left join public.student_chat_message_reads as reads on reads.message_id = requested.message_id
  group by requested.message_id;
$$;

revoke all on function public.student_chat_read_counts(uuid[]) from public, anon, authenticated;
grant execute on function public.student_chat_read_counts(uuid[]) to service_role;

create table if not exists public.student_chat_bans (
  student_id text primary key check (char_length(btrim(student_id)) between 1 and 80),
  student_name text not null,
  created_at timestamptz not null default now(),
  banned_by text not null
);

alter table public.student_chat_settings disable row level security;
alter table public.student_chat_messages disable row level security;
alter table public.student_chat_attachments disable row level security;
alter table public.student_chat_message_reads disable row level security;
alter table public.student_chat_bans disable row level security;

revoke all on public.student_chat_settings, public.student_chat_messages, public.student_chat_attachments,
  public.student_chat_message_reads, public.student_chat_bans
  from anon, authenticated;
grant all on public.student_chat_settings, public.student_chat_messages, public.student_chat_attachments,
  public.student_chat_message_reads, public.student_chat_bans
  to service_role;

create extension if not exists pg_cron;

do $$
declare
  existing_job_id bigint;
begin
  select jobid into existing_job_id
  from cron.job
  where jobname = 'student-chat-delete-expired-messages';

  if existing_job_id is not null then
    perform cron.unschedule(existing_job_id);
  end if;

  perform cron.schedule(
    'student-chat-delete-expired-messages',
    '* * * * *',
    $job$delete from public.student_chat_messages where created_at < now() - interval '48 hours';$job$
  );
end $$;
