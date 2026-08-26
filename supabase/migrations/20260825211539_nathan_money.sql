-- Finances: income, expenses, and bills. Bills stay 'open' until paid
-- (marked 'done'), and open bills surface on the calendar by due date.
create table if not exists memory.money (
  id         bigserial primary key,
  kind       text not null check (kind in ('income','expense','bill')),
  title      text not null,
  amount     numeric(12,2) not null check (amount >= 0),
  category   text,
  note       text,
  when_at    timestamptz not null default now(),  -- happened at / bill due date
  status     text not null default 'done' check (status in ('open','done','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists money_when_idx on memory.money (when_at);
create index if not exists money_kind_idx on memory.money (kind, status);
alter table memory.money enable row level security;

drop trigger if exists money_touch_updated_at on memory.money;
create trigger money_touch_updated_at
  before update on memory.money
  for each row execute function memory.touch_updated_at();

-- One month's entries plus every open bill (whatever its due date)
create or replace function public.nathan_money(
  p_from timestamptz default date_trunc('month', now()),
  p_to   timestamptz default (date_trunc('month', now()) + interval '1 month')
)
returns table(id bigint, kind text, title text, amount numeric, category text, note text, when_at timestamptz, status text)
language sql security definer set search_path = '' as $$
  select m.id, m.kind, m.title, m.amount, m.category, m.note, m.when_at, m.status
  from memory.money m
  where m.status <> 'archived'
    and ((m.when_at >= p_from and m.when_at < p_to) or (m.kind = 'bill' and m.status = 'open'))
  order by m.when_at desc
$$;

create or replace function public.nathan_money_add(
  p_kind text, p_title text, p_amount numeric,
  p_category text default null, p_note text default null,
  p_when timestamptz default now(), p_status text default null
) returns bigint
language sql security definer set search_path = '' as $$
  insert into memory.money (kind, title, amount, category, note, when_at, status)
  values (p_kind, p_title, p_amount, p_category, p_note, coalesce(p_when, now()),
          coalesce(p_status, case when p_kind = 'bill' then 'open' else 'done' end))
  returning id
$$;

-- null argument = keep the current value
create or replace function public.nathan_money_update(
  p_id bigint, p_title text default null, p_amount numeric default null,
  p_category text default null, p_note text default null,
  p_when timestamptz default null, p_status text default null
) returns boolean
language sql security definer set search_path = '' as $$
  update memory.money set
    title    = coalesce(p_title, title),
    amount   = coalesce(p_amount, amount),
    category = coalesce(p_category, category),
    note     = coalesce(p_note, note),
    when_at  = coalesce(p_when, when_at),
    status   = coalesce(p_status, status)
  where id = p_id
  returning true
$$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'public.nathan_money(timestamptz,timestamptz)',
    'public.nathan_money_add(text,text,numeric,text,text,timestamptz,text)',
    'public.nathan_money_update(bigint,text,numeric,text,text,timestamptz,text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end $$;
