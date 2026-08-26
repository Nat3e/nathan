-- Past events clean themselves up: an hourly job archives any open event
-- whose end (or start, if it has no end) is more than 24 hours gone.
-- They vanish from the board, calendar, and Nathan's context — the app
-- additionally hides ended events from "Coming Up" the moment they finish.
-- Disable any time with: select cron.unschedule('nathan-archive-past');
select cron.schedule(
  'nathan-archive-past',
  '15 * * * *',
  $$
  update memory.items
     set status = 'archived'
   where kind = 'event'
     and status = 'open'
     and coalesce(end_at, when_at) < now() - interval '24 hours';
  $$
);
