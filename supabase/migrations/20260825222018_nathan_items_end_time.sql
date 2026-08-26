-- Events can span a range: when_at → end_at ("shift from 11:00 to 17:30")
alter table memory.items add column if not exists end_at timestamptz;

-- return type changes, so the old functions are dropped and recreated
drop function if exists public.nathan_items();
create function public.nathan_items()
returns table(
  id bigint, kind text, title text, detail text, area text, tag text,
  tag_text text, status text, when_at timestamptz, end_at timestamptz,
  percent int, created_at timestamptz
)
language sql security definer set search_path = '' as $$
  select i.id, i.kind, i.title, i.detail, i.area, i.tag,
         i.tag_text, i.status, i.when_at, i.end_at, i.percent, i.created_at
  from memory.items i
  where i.status <> 'archived'
  order by i.kind, coalesce(i.when_at, i.created_at)
$$;

drop function if exists public.nathan_item_add(text,text,text,text,text,text,timestamptz,int);
create function public.nathan_item_add(
  p_kind text, p_title text, p_detail text default null, p_area text default null,
  p_tag text default '', p_tag_text text default null,
  p_when timestamptz default null, p_percent int default null,
  p_end timestamptz default null
) returns bigint
language sql security definer set search_path = '' as $$
  insert into memory.items (kind, title, detail, area, tag, tag_text, when_at, percent, end_at)
  values (p_kind, p_title, p_detail, p_area, coalesce(p_tag,''), p_tag_text, p_when, p_percent, p_end)
  returning id
$$;

drop function if exists public.nathan_item_update(bigint,text,text,text,text,text,timestamptz,int,text);
create function public.nathan_item_update(
  p_id bigint, p_title text default null, p_detail text default null, p_area text default null,
  p_tag text default null, p_tag_text text default null,
  p_when timestamptz default null, p_percent int default null, p_status text default null,
  p_end timestamptz default null
) returns boolean
language sql security definer set search_path = '' as $$
  update memory.items set
    title    = coalesce(p_title, title),
    detail   = coalesce(p_detail, detail),
    area     = coalesce(p_area, area),
    tag      = coalesce(p_tag, tag),
    tag_text = coalesce(p_tag_text, tag_text),
    when_at  = coalesce(p_when, when_at),
    end_at   = coalesce(p_end, end_at),
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
    'public.nathan_item_add(text,text,text,text,text,text,timestamptz,int,timestamptz)',
    'public.nathan_item_update(bigint,text,text,text,text,text,timestamptz,int,text,timestamptz)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end $$;
