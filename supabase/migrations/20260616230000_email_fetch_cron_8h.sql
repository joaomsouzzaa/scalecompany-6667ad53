-- Captura diária de e-mails às 8h (horário de Brasília = 11:00 UTC).
-- Chama a edge function `email` com action fetch_emails, que varre as últimas
-- 72h, filtra por palavras-chave, gera rascunhos via OpenAI e dispara o
-- relatório no WhatsApp.
--
-- Auth: usa a anon/publishable key apenas para acionar a function. A própria
-- edge function `email` lê SUPABASE_SERVICE_ROLE_KEY do ambiente (injetada
-- pelo Lovable Cloud) para falar com o banco — nenhum segredo fica em texto
-- plano na tabela settings.

DO $$
BEGIN
  PERFORM cron.unschedule('email-fetch-diario') FROM cron.job WHERE jobname = 'email-fetch-diario';
END $$;

SELECT cron.schedule(
  'email-fetch-diario',
  '0 11 * * *',
  $$
  SELECT net.http_post(
    url := (SELECT value FROM settings WHERE key = 'supabase_url') || '/functions/v1/email',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT value FROM settings WHERE key = 'anon_key')
    ),
    body := '{"action":"fetch_emails"}'
  )
  $$
);
