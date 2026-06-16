-- Sync da Kiwify passa a rodar 1x/dia às 8h (horário de Brasília = 11:00 UTC),
-- processando só as últimas 72h (filtro feito na própria edge function).
-- Substitui o agendamento horário.

DO $$
BEGIN
  PERFORM cron.unschedule('sync-kiwify-hourly') FROM cron.job WHERE jobname = 'sync-kiwify-hourly';
  PERFORM cron.unschedule('sync-kiwify-diario') FROM cron.job WHERE jobname = 'sync-kiwify-diario';
END $$;

SELECT cron.schedule(
  'sync-kiwify-diario',
  '0 11 * * *',
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
