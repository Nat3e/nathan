-- Live board behind the dashboard panels: tasks, waiting-on, planned events,
-- projects. One row per item; the calendar reads everything with a when_at.
create table if not exists memory.items (
  id         bigserial primary key,
  kind       text not null check (kind in ('task','waiting','event','project')),
  title      text not null,
  detail     text,
  area       text,
  tag        text not null default '',
  tag_text   text,
  status     text not null default 'open' check (status in ('open','done','archived')),
  when_at    timestamptz,
  percent    int check (percent between 0 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists items_kind_idx on memory.items (kind, status);
create index if not exists items_when_idx on memory.items (when_at);
alter table memory.items enable row level security;

drop trigger if exists items_touch_updated_at on memory.items;
create trigger items_touch_updated_at
  before update on memory.items
  for each row execute function memory.touch_updated_at();

-- Same doorway pattern as the rest: SECURITY DEFINER functions in public,
-- executable by service_role only.

create or replace function public.nathan_items()
returns table(
  id bigint, kind text, title text, detail text, area text, tag text,
  tag_text text, status text, when_at timestamptz, percent int, created_at timestamptz
)
language sql security definer set search_path = '' as $$
  select i.id, i.kind, i.title, i.detail, i.area, i.tag,
         i.tag_text, i.status, i.when_at, i.percent, i.created_at
  from memory.items i
  where i.status <> 'archived'
  order by i.kind, coalesce(i.when_at, i.created_at)
$$;

create or replace function public.nathan_item_add(
  p_kind text, p_title text, p_detail text default null, p_area text default null,
  p_tag text default '', p_tag_text text default null,
  p_when timestamptz default null, p_percent int default null
) returns bigint
language sql security definer set search_path = '' as $$
  insert into memory.items (kind, title, detail, area, tag, tag_text, when_at, percent)
  values (p_kind, p_title, p_detail, p_area, coalesce(p_tag,''), p_tag_text, p_when, p_percent)
  returning id
$$;

-- null argument = keep the current value (clear a field by archiving + re-adding)
create or replace function public.nathan_item_update(
  p_id bigint, p_title text default null, p_detail text default null, p_area text default null,
  p_tag text default null, p_tag_text text default null,
  p_when timestamptz default null, p_percent int default null, p_status text default null
) returns boolean
language sql security definer set search_path = '' as $$
  update memory.items set
    title    = coalesce(p_title, title),
    detail   = coalesce(p_detail, detail),
    area     = coalesce(p_area, area),
    tag      = coalesce(p_tag, tag),
    tag_text = coalesce(p_tag_text, tag_text),
    when_at  = coalesce(p_when, when_at),
    percent  = coalesce(p_percent, percent),
    status   = coalesce(p_status, status)
  where id = p_id
  returning true
$$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'public.nathan_items()',
    'public.nathan_item_add(text,text,text,text,text,text,timestamptz,int)',
    'public.nathan_item_update(bigint,text,text,text,text,text,timestamptz,int,text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end $$;
