-- Conversation history so Nathan remembers what was said
create table if not exists memory.conversations (
  id         bigserial primary key,
  session    text not null default 'default',
  role       text not null check (role in ('user','assistant')),
  content    text not null,
  created_at timestamptz not null default now()
);
create index if not exists conv_session_idx on memory.conversations (session, created_at desc);
alter table memory.conversations enable row level security;

-- The `memory` schema is NOT exposed to PostgREST on purpose.
-- These SECURITY DEFINER functions in `public` are the only doorway, and only
-- service_role may execute them — the public anon key cannot reach memory.

create or replace function public.nathan_memory()
returns table(path text, description text, content text)
language sql security definer set search_path = '' as $$
  select f.path, f.description, f.content from memory.files f order by f.path
$$;

create or replace function public.nathan_remember(
  p_path text, p_name text, p_category text, p_description text, p_content text
) returns void
language sql security definer set search_path = '' as $$
  insert into memory.files (path, name, category, description, content)
  values (p_path, p_name, p_category, p_description, p_content)
  on conflict (path) do update
    set content     = excluded.content,
        description = coalesce(excluded.description, memory.files.description),
        category    = excluded.category;
  insert into memory.log (path, action, note) values (p_path, 'write', 'via nathan-brain');
$$;

create or replace function public.nathan_history(p_session text, p_limit int default 20)
returns table(role text, content text)
language sql security definer set search_path = '' as $$
  select c.role, c.content from (
    select * from memory.conversations
    where session = p_session order by created_at desc limit p_limit
  ) c order by c.created_at asc
$$;

create or replace function public.nathan_log_turn(p_session text, p_role text, p_content text)
returns void
language sql security definer set search_path = '' as $$
  insert into memory.conversations (session, role, content) values (p_session, p_role, p_content);
$$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'public.nathan_memory()',
    'public.nathan_remember(text,text,text,text,text)',
    'public.nathan_history(text,int)',
    'public.nathan_log_turn(text,text,text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end $$;
