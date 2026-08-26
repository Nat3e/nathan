-- RPCs for the bank email sync (PostgREST only exposes public, so the edge
-- function reaches memory.bank_seen through these; service_role only).

create or replace function public.nathan_bank_unseen(p_uids bigint[])
returns setof bigint
language sql
security definer
set search_path = memory, public
as $$
  select u from unnest(p_uids) as u
  where not exists (select 1 from memory.bank_seen s where s.uid = u);
$$;

create or replace function public.nathan_bank_mark(p_uids bigint[])
returns void
language sql
security definer
set search_path = memory, public
as $$
  insert into memory.bank_seen (uid)
  select u from unnest(p_uids) as u
  on conflict (uid) do nothing;
$$;

revoke all on function public.nathan_bank_unseen(bigint[]) from public, anon, authenticated;
revoke all on function public.nathan_bank_mark(bigint[]) from public, anon, authenticated;
grant execute on function public.nathan_bank_unseen(bigint[]) to service_role;
grant execute on function public.nathan_bank_mark(bigint[]) to service_role;
