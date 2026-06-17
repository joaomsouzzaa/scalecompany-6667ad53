-- Módulo E-mail: passa de conta ÚNICA (singleton id=1) para MÚLTIPLAS contas.
-- Cada conta tem nome, credenciais próprias, keywords e número de relatório.

-- 1) Remove a restrição de linha única e adiciona campos de identificação
ALTER TABLE public.email_config DROP CONSTRAINT IF EXISTS email_config_singleton;
ALTER TABLE public.email_config ADD COLUMN IF NOT EXISTS nome TEXT;
ALTER TABLE public.email_config ADD COLUMN IF NOT EXISTS ativo BOOLEAN NOT NULL DEFAULT true;

-- 2) Sequência para gerar ids das novas contas (a existente fica com id=1)
CREATE SEQUENCE IF NOT EXISTS public.email_config_id_seq OWNED BY public.email_config.id;
SELECT setval('public.email_config_id_seq', GREATEST((SELECT COALESCE(MAX(id), 1) FROM public.email_config), 1));
ALTER TABLE public.email_config ALTER COLUMN id SET DEFAULT nextval('public.email_config_id_seq');

-- 3) Nomeia a conta já existente
UPDATE public.email_config SET nome = COALESCE(NULLIF(nome, ''), NULLIF(username, ''), 'Conta principal') WHERE id = 1;

-- 4) Associa cada e-mail à conta de origem
ALTER TABLE public.email_mensagens
  ADD COLUMN IF NOT EXISTS email_config_id INTEGER REFERENCES public.email_config(id) ON DELETE SET NULL;
UPDATE public.email_mensagens SET email_config_id = 1 WHERE email_config_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_email_mensagens_config ON public.email_mensagens(email_config_id);

-- 5) Permissão de uso da sequência para os papéis do app
GRANT USAGE, SELECT ON SEQUENCE public.email_config_id_seq TO anon, authenticated, service_role;
