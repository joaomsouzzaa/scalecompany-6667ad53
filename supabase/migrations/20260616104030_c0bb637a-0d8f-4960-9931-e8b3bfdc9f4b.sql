DO $$
BEGIN
  PERFORM cron.unschedule('sync-kiwify-diario') FROM cron.job WHERE jobname = 'sync-kiwify-diario';
  PERFORM cron.unschedule('sync-kiwify-hourly') FROM cron.job WHERE jobname = 'sync-kiwify-hourly';
END $$;

SELECT cron.schedule(
  'sync-kiwify-hourly',
  '0 * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT value FROM settings WHERE key = 'supabase_url') || '/functions/v1/sync-kiwify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT value FROM settings WHERE key = 'service_role_key')
    ),
    body := '{}'
  )
  $$
);