-- The Night Shift: every day at 09:30 UTC (05:30 Rosemère in summer,
-- 04:30 in winter) call nathan-nightshift, which writes the morning
-- briefing to /briefings/latest.md.
-- The access key is read from Vault (secret name: nathan_access_key) —
-- create it once with: select vault.create_secret('<key>', 'nathan_access_key');
-- Disable any time with: select cron.unschedule('nathan-nightshift');
select cron.schedule(
  'nathan-nightshift',
  '30 9 * * *',
  $$
  select net.http_post(
    url := 'https://pgsbqcpmnjhfhonswtin.supabase.co/functions/v1/nathan-nightshift',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-nathan-key', (select decrypted_secret from vault.decrypted_secrets where name = 'nathan_access_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);
