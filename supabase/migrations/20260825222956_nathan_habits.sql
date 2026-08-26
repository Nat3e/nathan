-- Habits: items of kind 'habit', ticked off day by day in habit_marks
alter table memory.items drop constraint if exists items_kind_check;
alter table memory.items add constraint items_kind_check
  check (kind in ('task','waiting','event','project','habit'));

create table if not exists memory.habit_marks (
  item_id    bigint not null references memory.items(id) on delete cascade,
  day        date not null,
  created_at timestamptz not null default now(),
  primary key (item_id, day)
);
alter table memory.habit_marks enable row level security;

-- flip a day's mark; returns the new state (true = done that day)
create or replace function public.nathan_habit_toggle(
  p_id bigint,
  p_day date default (now() at time zone 'America/Toronto')::date
) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  delete from memory.habit_marks where item_id = p_id and day = p_day;
  if found then return false; end if;
  insert into memory.habit_marks (item_id, day) values (p_id, p_day);
  return true;
end $$;

create or replace function public.nathan_habit_marks(p_from date, p_to date)
returns table(item_id bigint, day date)
language sql security definer set search_path = '' as $$
  select m.item_id, m.day from memory.habit_marks m where m.day between p_from and p_to
$$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'public.nathan_habit_toggle(bigint,date)',
    'public.nathan_habit_marks(date,date)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end $$;
