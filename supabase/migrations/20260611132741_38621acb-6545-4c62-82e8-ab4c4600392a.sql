SELECT cron.schedule(
  'sync-kiwify-diario',
  '0 11 * * *',
  $$
  SELECT net.http_post(
    url := (select value from settings where key = 'supabase_url') || '/functions/v1/sync-kiwify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select value from settings where key = 'service_role_key')
    ),
    body := '{}'
  )
  $$
);