-- Complementa o módulo E-mail (criado em 20260616131459) com os campos
-- necessários para: relatório no WhatsApp, filtro por palavras-chave e
-- armazenamento do resumo/categoria gerados pela IA.

-- email_config: destino do relatório + palavras-chave configuráveis
ALTER TABLE public.email_config
  ADD COLUMN IF NOT EXISTS whatsapp_destino TEXT,
  ADD COLUMN IF NOT EXISTS keywords TEXT[] NOT NULL DEFAULT array[
    'workshop','workshop scale','cancelamento','cancelar','reembolso','estorno',
    'devolução','desistência','troca de ingresso','transferência','nota fiscal',
    'comprovante','pagamento','ingresso','inscrição','dúvida','reclamação'
  ]::text[],
  ADD COLUMN IF NOT EXISTS ultima_execucao TIMESTAMPTZ;

-- email_mensagens: resumo e categoria (qual palavra-chave bateu)
ALTER TABLE public.email_mensagens
  ADD COLUMN IF NOT EXISTS resumo TEXT,
  ADD COLUMN IF NOT EXISTS categoria TEXT;
