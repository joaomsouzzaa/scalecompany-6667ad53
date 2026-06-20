-- Sync extra da Kiwify às 11h30 BRT (14:30 UTC), para o resumo do dia do
-- evento (disparado às 12h) sair com os dados mais atualizados.
-- Não substitui o sync-kiwify-diario das 8h; é um disparo adicional.

DO $$
BEGIN
  PERFORM cron.unschedule('sync-kiwify-pre-evento')
    FROM cron.job WHERE jobname = 'sync-kiwify-pre-evento';
END $$;

SELECT cron.schedule(
  'sync-kiwify-pre-evento',
  '30 14 * * *',
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
