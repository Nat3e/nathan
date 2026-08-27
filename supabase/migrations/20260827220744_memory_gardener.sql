-- The Memory Gardener: once a day (09:10 UTC, just before the Night Shift)
-- Nathan re-reads the last day's conversations and quietly files away the
-- durable facts — no "remember this" needed. Conservative by design: only
-- facts Nataniel himself stated, merged into existing files, skip if unsure.
-- Disable any time with: select cron.unschedule('nathan-gardener');

create or replace function public.nathan_recent_turns(p_hours int default 26)
returns table(role text, content text, session text, created_at timestamptz)
language sql
security definer
set search_path = memory, public
as $$
  select c.role, c.content, c.session, c.created_at
  from memory.conversations c
  where c.created_at > now() - make_interval(hours => p_hours)
  order by c.created_at
  limit 400;
$$;

revoke all on function public.nathan_recent_turns(int) from public, anon, authenticated;
grant execute on function public.nathan_recent_turns(int) to service_role;

select cron.schedule(
  'nathan-gardener',
  '10 9 * * *',
  $$
  select net.http_post(
    url := 'https://pgsbqcpmnjhfhonswtin.supabase.co/functions/v1/nathan-gardener',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-nathan-key', (select decrypted_secret from vault.decrypted_secrets where name = 'nathan_access_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);
