
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Remove jobs antigos com mesmo nome
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT jobid FROM cron.job WHERE jobname = 'email-fetch-diario' LOOP
    PERFORM cron.unschedule(r.jobid);
  END LOOP;
END $$;

SELECT cron.schedule(
  'email-fetch-diario',
  '0 11 * * *',
  $$
  SELECT net.http_post(
    url := (SELECT value FROM public.settings WHERE key = 'supabase_url') || '/functions/v1/email',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT value FROM public.settings WHERE key = 'service_role_key')
    ),
    body := jsonb_build_object('action', 'fetch_emails')
  ) AS request_id;
  $$
);
