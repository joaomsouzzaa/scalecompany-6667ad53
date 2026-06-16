-- Ingressos emitidos: 1 linha por PESSOA/ingresso
CREATE TABLE IF NOT EXISTS public.ingressos_emitidos (
  id          UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  venda_id    UUID REFERENCES public.vendas(id) ON DELETE CASCADE,
  order_id    TEXT,
  ingresso_id TEXT,
  external_id TEXT,
  nome        TEXT,
  email       TEXT,
  telefone    TEXT,
  cpf         TEXT,
  cidade      TEXT,
  tipo_ingresso TEXT,
  plataforma  TEXT,
  batch_name  TEXT,
  status      TEXT NOT NULL DEFAULT 'aprovada',
  data_venda  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  checkin_at  TIMESTAMP WITH TIME ZONE,
  created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ingressos_emitidos TO anon, authenticated;
GRANT ALL ON public.ingressos_emitidos TO service_role;

CREATE UNIQUE INDEX IF NOT EXISTS ingressos_emitidos_ingresso_id_uniq
  ON public.ingressos_emitidos (ingresso_id) WHERE ingresso_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ingressos_emitidos_order_id_idx ON public.ingressos_emitidos (order_id);
CREATE INDEX IF NOT EXISTS ingressos_emitidos_venda_id_idx ON public.ingressos_emitidos (venda_id);
CREATE INDEX IF NOT EXISTS ingressos_emitidos_cidade_idx   ON public.ingressos_emitidos (cidade);
CREATE INDEX IF NOT EXISTS ingressos_emitidos_data_idx     ON public.ingressos_emitidos (data_venda);

ALTER TABLE public.ingressos_emitidos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Permitir leitura de ingressos" ON public.ingressos_emitidos;
DROP POLICY IF EXISTS "Insert ingressos via service role" ON public.ingressos_emitidos;
DROP POLICY IF EXISTS "Insert ingressos via anon" ON public.ingressos_emitidos;
DROP POLICY IF EXISTS "Insert ingressos via authenticated" ON public.ingressos_emitidos;
DROP POLICY IF EXISTS "Update ingressos" ON public.ingressos_emitidos;
DROP POLICY IF EXISTS "Delete ingressos" ON public.ingressos_emitidos;

CREATE POLICY "Permitir leitura de ingressos" ON public.ingressos_emitidos FOR SELECT USING (true);
CREATE POLICY "Insert ingressos via service role" ON public.ingressos_emitidos FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY "Insert ingressos via anon" ON public.ingressos_emitidos FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Insert ingressos via authenticated" ON public.ingressos_emitidos FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Update ingressos" ON public.ingressos_emitidos FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "Delete ingressos" ON public.ingressos_emitidos FOR DELETE USING (true);

CREATE OR REPLACE FUNCTION public.buscar_ingressos_emitidos(
  p_status text,
  p_start timestamp with time zone,
  p_end timestamp with time zone,
  p_city_slug text DEFAULT NULL::text
)
RETURNS SETOF public.ingressos_emitidos
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT *
  FROM ingressos_emitidos
  WHERE (p_status = 'all' OR status = p_status)
    AND data_venda >= p_start
    AND data_venda <= p_end
    AND (
      p_city_slug IS NULL
      OR replace(immutable_unaccent(lower(cidade)), ' ', '') ILIKE '%' || replace(immutable_unaccent(lower(p_city_slug)), ' ', '') || '%'
    )
  ORDER BY data_venda ASC;
$$;