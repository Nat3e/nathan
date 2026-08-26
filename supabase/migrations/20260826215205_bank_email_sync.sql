-- ─────────────────────────────────────────────────────────────────────────────
--  BANK EMAIL SYNC
--  Nathan watches the inbox for bank alert emails (transactions, balances),
--  logs them into the money tracker, and remembers the latest balance.
--  Credentials never involved: it reads only the alert emails the bank sends.
--
--  memory.bank_seen remembers which mail UIDs were already processed, so an
--  alert is never logged twice. The hourly cron calls nathan-mail's
--  bank_sync action; with no new candidate mail it costs nothing.
--  Disable any time with: select cron.unschedule('nathan-bank-sync');
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists memory.bank_seen (
  uid bigint primary key,
  at  timestamptz not null default now()
);

select cron.schedule(
  'nathan-bank-sync',
  '7 * * * *',
  $$
  select net.http_post(
    url := 'https://pgsbqcpmnjhfhonswtin.supabase.co/functions/v1/nathan-mail',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-nathan-key', (select decrypted_secret from vault.decrypted_secrets where name = 'nathan_access_key')
    ),
    body := '{"action":"bank_sync"}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
