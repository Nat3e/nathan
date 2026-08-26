-- Private Storage bucket for Nathan's memory files
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('Memory', 'Memory', false, 5242880, array['text/markdown','text/plain'])
on conflict (id) do nothing;

-- Markdown-document memory store (readable/writable via SQL)
create schema if not exists memory;

create table if not exists memory.files (
  path          text primary key,
  name          text not null,
  category      text not null default 'topics',
  description   text,
  content       text not null,
  aliases       text[] not null default '{}',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists memory.log (
  id         bigserial primary key,
  path       text not null,
  action     text not null,
  note       text,
  created_at timestamptz not null default now()
);

create index if not exists files_category_idx on memory.files (category);
create index if not exists files_content_fts_idx on memory.files
  using gin (to_tsvector('english', coalesce(description,'') || ' ' || content));

create or replace function memory.touch_updated_at() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists files_touch_updated_at on memory.files;
create trigger files_touch_updated_at
  before update on memory.files
  for each row execute function memory.touch_updated_at();

-- Lock it down: no anon/authenticated access. Only the service role / SQL editor.
alter table memory.files enable row level security;
alter table memory.log   enable row level security;
revoke all on schema memory from anon, authenticated;
revoke all on all tables in schema memory from anon, authenticated;
