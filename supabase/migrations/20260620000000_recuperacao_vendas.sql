-- Recuperação de vendas: leads vindos de "carrinho abandonado" e "compra recusada".
-- Cada lead recebe um fluxo de mensagens de recuperação no WhatsApp (passos com
-- tempo configurável), respeitando a janela 7h–22h. Quando a pessoa compra
-- (compra aprovada), o lead vira "comprou" e o fluxo para.

CREATE TABLE IF NOT EXISTS public.recuperacao_leads (
  id              UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tipo_evento     TEXT NOT NULL,                      -- 'abandono' | 'recusada'
  id_transacao    TEXT,
  nome            TEXT,
  email           TEXT,
  telefone        TEXT,
  produto         TEXT,
  cidade          TEXT,
  valor           NUMERIC(10,2),
  tipo_ingresso   TEXT,
  plataforma      TEXT,
  payload         JSONB,
  status          TEXT NOT NULL DEFAULT 'aguardando', -- aguardando | em_fluxo | comprou | fluxo_concluido
  proxima_ordem   INTEGER NOT NULL DEFAULT 1,
  proximo_envio_em TIMESTAMP WITH TIME ZONE,
  comprou_em      TIMESTAMP WITH TIME ZONE,
  data_venda      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Dedup por transação (reentregas do webhook não duplicam).
CREATE UNIQUE INDEX IF NOT EXISTS recuperacao_leads_id_transacao_uniq
  ON public.recuperacao_leads (id_transacao) WHERE id_transacao IS NOT NULL;
CREATE INDEX IF NOT EXISTS recuperacao_leads_telefone_idx ON public.recuperacao_leads (telefone);
CREATE INDEX IF NOT EXISTS recuperacao_leads_email_idx    ON public.recuperacao_leads (email);
CREATE INDEX IF NOT EXISTS recuperacao_leads_status_idx   ON public.recuperacao_leads (status);
CREATE INDEX IF NOT EXISTS recuperacao_leads_proximo_idx  ON public.recuperacao_leads (proximo_envio_em);
CREATE INDEX IF NOT EXISTS recuperacao_leads_data_idx     ON public.recuperacao_leads (data_venda);

ALTER TABLE public.recuperacao_leads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Permitir leitura recuperacao" ON public.recuperacao_leads FOR SELECT USING (true);
CREATE POLICY "Insert recuperacao service role" ON public.recuperacao_leads FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY "Insert recuperacao anon" ON public.recuperacao_leads FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Insert recuperacao auth" ON public.recuperacao_leads FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Update recuperacao" ON public.recuperacao_leads FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "Delete recuperacao" ON public.recuperacao_leads FOR DELETE USING (true);

DROP TRIGGER IF EXISTS trg_recuperacao_leads_updated ON public.recuperacao_leads;
CREATE TRIGGER trg_recuperacao_leads_updated BEFORE UPDATE ON public.recuperacao_leads
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Passos do fluxo de recuperação, ligados a uma notificação (gatilho 'recuperacao_venda').
CREATE TABLE IF NOT EXISTS public.recuperacao_mensagens (
  id              UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  notificacao_id  UUID NOT NULL REFERENCES public.notificacoes(id) ON DELETE CASCADE,
  ordem           INTEGER NOT NULL,
  delay_valor     INTEGER NOT NULL DEFAULT 2,
  delay_unidade   TEXT NOT NULL DEFAULT 'horas',      -- 'horas' | 'minutos'
  mensagem        TEXT NOT NULL,
  ativo           BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (notificacao_id, ordem)
);

ALTER TABLE public.recuperacao_mensagens ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth manage recuperacao_mensagens" ON public.recuperacao_mensagens
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "service recuperacao_mensagens" ON public.recuperacao_mensagens
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Status do envio dos parabéns ao comprador (gatilho 'compra_realizada').
ALTER TABLE public.vendas ADD COLUMN IF NOT EXISTS msg_compra_status TEXT;
ALTER TABLE public.vendas ADD COLUMN IF NOT EXISTS msg_compra_erro   TEXT;
ALTER TABLE public.vendas ADD COLUMN IF NOT EXISTS msg_compra_em     TIMESTAMP WITH TIME ZONE;

-- RPC espelhando buscar_ingressos_emitidos (mesmo filtro de cidade).
CREATE OR REPLACE FUNCTION public.buscar_recuperacao_leads(
  p_status text,
  p_start timestamp with time zone,
  p_end timestamp with time zone,
  p_city_slug text DEFAULT NULL::text
)
RETURNS SETOF public.recuperacao_leads
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT *
  FROM recuperacao_leads
  WHERE (p_status = 'all' OR status = p_status)
    AND data_venda >= p_start
    AND data_venda <= p_end
    AND (
      p_city_slug IS NULL
      OR replace(immutable_unaccent(lower(cidade)), ' ', '') ILIKE '%' || replace(immutable_unaccent(lower(p_city_slug)), ' ', '') || '%'
    )
  ORDER BY data_venda DESC;
$$;

-- Cron: processa o fluxo de recuperação a cada minuto (a função respeita horário/agendamento).
DO $$
BEGIN
  PERFORM cron.unschedule('recuperacao-processar') FROM cron.job WHERE jobname = 'recuperacao-processar';
END $$;

SELECT cron.schedule(
  'recuperacao-processar',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT value FROM settings WHERE key = 'supabase_url') || '/functions/v1/uazapi',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT value FROM settings WHERE key = 'service_role_key')
    ),
    body := '{"action":"recuperacao_processar"}'
  )
  $$
);
