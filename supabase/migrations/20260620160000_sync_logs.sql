-- Histórico de execuções da sync-kiwify: 1 linha por rodada (auto ou manual),
-- guardando o relatório enviado, o detalhe por cidade e o status (ok/erro).
-- Alimenta o "Log das últimas sincronizações" no popup da tela de Vendas.

CREATE TABLE IF NOT EXISTS public.sync_logs (
  id                 UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  executado_em       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  origem             TEXT NOT NULL DEFAULT 'auto',   -- 'auto' (cron) | 'manual' (botão)
  dias_janela        INTEGER,                        -- janela usada; NULL = histórico completo
  cidades_ativas     INTEGER NOT NULL DEFAULT 0,
  convites_inseridos INTEGER NOT NULL DEFAULT 0,
  vendas_faltando    INTEGER NOT NULL DEFAULT 0,
  erros              INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'ok',      -- 'ok' | 'erro'
  relatorio          TEXT,                            -- texto enviado no WhatsApp
  detalhe            JSONB,                            -- por cidade (kiwify x banco, inseridos, faltando, erros)
  relatorio_enviados INTEGER NOT NULL DEFAULT 0,
  relatorio_erros    JSONB,
  mensagem_erro      TEXT
);

CREATE INDEX IF NOT EXISTS sync_logs_executado_idx ON public.sync_logs (executado_em DESC);

-- RLS espelhando ingressos_emitidos: leitura pública; escrita via service/anon/auth.
ALTER TABLE public.sync_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Leitura sync_logs"        ON public.sync_logs FOR SELECT USING (true);
CREATE POLICY "Insert sync_logs service" ON public.sync_logs FOR INSERT TO service_role  WITH CHECK (true);
CREATE POLICY "Insert sync_logs anon"    ON public.sync_logs FOR INSERT TO anon          WITH CHECK (true);
CREATE POLICY "Insert sync_logs auth"    ON public.sync_logs FOR INSERT TO authenticated WITH CHECK (true);
