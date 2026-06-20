-- Módulo "Meta Vs Faturado": a meta e o faturado do mês vêm do NOME de um grupo
-- de WhatsApp (ex.: "Scale Company (847.250/2.705.000)") na instância conectada.
-- Primeiro número = faturado, segundo = meta. A edge function `uazapi` (action
-- `meta_sync`) relê o nome do grupo a cada 10 min, atualiza a config e grava um
-- snapshot para o gráfico de evolução.

-- Config (single-row): qual instância/grupo seguir + último valor lido.
CREATE TABLE IF NOT EXISTS public.meta_faturado_config (
  id            UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  instancia     TEXT NOT NULL DEFAULT 'escalinho',
  grupo_id      TEXT,
  grupo_nome    TEXT,
  faturado      NUMERIC(14,2) NOT NULL DEFAULT 0,
  meta          NUMERIC(14,2) NOT NULL DEFAULT 0,
  atualizado_em TIMESTAMP WITH TIME ZONE,
  updated_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.meta_faturado_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Leitura meta_faturado_config" ON public.meta_faturado_config FOR SELECT USING (true);
CREATE POLICY "Manage meta_faturado_config auth" ON public.meta_faturado_config FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Manage meta_faturado_config anon" ON public.meta_faturado_config FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Manage meta_faturado_config service" ON public.meta_faturado_config FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP TRIGGER IF EXISTS trg_meta_faturado_config_updated ON public.meta_faturado_config;
CREATE TRIGGER trg_meta_faturado_config_updated BEFORE UPDATE ON public.meta_faturado_config
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Linha inicial (segue o grupo "Scale Company" por nome até o usuário escolher).
INSERT INTO public.meta_faturado_config (instancia, grupo_nome)
SELECT 'escalinho', 'Scale Company'
WHERE NOT EXISTS (SELECT 1 FROM public.meta_faturado_config);

-- Histórico para o gráfico de evolução do mês.
CREATE TABLE IF NOT EXISTS public.meta_faturado_snapshots (
  id         UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  faturado   NUMERIC(14,2) NOT NULL DEFAULT 0,
  meta       NUMERIC(14,2) NOT NULL DEFAULT 0,
  captado_em TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meta_faturado_snapshots_captado_idx ON public.meta_faturado_snapshots (captado_em);

ALTER TABLE public.meta_faturado_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Leitura meta_faturado_snapshots" ON public.meta_faturado_snapshots FOR SELECT USING (true);
CREATE POLICY "Insert meta_faturado_snapshots service" ON public.meta_faturado_snapshots FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY "Insert meta_faturado_snapshots anon" ON public.meta_faturado_snapshots FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Insert meta_faturado_snapshots auth" ON public.meta_faturado_snapshots FOR INSERT TO authenticated WITH CHECK (true);

-- Cron: relê o nome do grupo a cada 10 min.
DO $$
BEGIN
  PERFORM cron.unschedule('meta-faturado-sync') FROM cron.job WHERE jobname = 'meta-faturado-sync';
END $$;

SELECT cron.schedule(
  'meta-faturado-sync',
  '*/10 * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT value FROM settings WHERE key = 'supabase_url') || '/functions/v1/uazapi',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT value FROM settings WHERE key = 'service_role_key')
    ),
    body := '{"action":"meta_sync"}'
  )
  $$
);
