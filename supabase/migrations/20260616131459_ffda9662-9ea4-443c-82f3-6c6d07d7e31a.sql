
-- settings (key/value)
CREATE TABLE IF NOT EXISTS public.settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.settings TO authenticated;
GRANT ALL ON public.settings TO service_role;
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "auth read settings" ON public.settings;
CREATE POLICY "auth read settings" ON public.settings FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "auth write settings" ON public.settings;
CREATE POLICY "auth write settings" ON public.settings FOR ALL TO authenticated USING (true) WITH CHECK (true);

INSERT INTO public.settings(key, value) VALUES
  ('supabase_url', 'https://dobexeqizssojpzuhkfn.supabase.co')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

-- service_role_key: insere apenas se não existir (precisa ser preenchido manualmente se ausente)
INSERT INTO public.settings(key, value)
SELECT 'service_role_key', ''
WHERE NOT EXISTS (SELECT 1 FROM public.settings WHERE key = 'service_role_key');

-- email_config (linha única id=1)
CREATE TABLE IF NOT EXISTS public.email_config (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  imap_host TEXT,
  imap_port INTEGER DEFAULT 993,
  smtp_host TEXT,
  smtp_port INTEGER DEFAULT 465,
  username TEXT,
  password TEXT,
  from_name TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_config TO authenticated;
GRANT ALL ON public.email_config TO service_role;
ALTER TABLE public.email_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "auth manage email_config" ON public.email_config;
CREATE POLICY "auth manage email_config" ON public.email_config FOR ALL TO authenticated USING (true) WITH CHECK (true);
INSERT INTO public.email_config(id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- email_mensagens
CREATE TABLE IF NOT EXISTS public.email_mensagens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id TEXT UNIQUE,
  from_email TEXT,
  from_name TEXT,
  to_email TEXT,
  subject TEXT,
  body TEXT,
  body_html TEXT,
  received_at TIMESTAMPTZ,
  draft_reply TEXT,
  status TEXT NOT NULL DEFAULT 'novo',
  replied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_mensagens TO authenticated;
GRANT ALL ON public.email_mensagens TO service_role;
ALTER TABLE public.email_mensagens ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "auth manage email_mensagens" ON public.email_mensagens;
CREATE POLICY "auth manage email_mensagens" ON public.email_mensagens FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_email_mensagens_received_at ON public.email_mensagens(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_mensagens_status ON public.email_mensagens(status);

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_email_config_updated ON public.email_config;
CREATE TRIGGER trg_email_config_updated BEFORE UPDATE ON public.email_config
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS trg_email_mensagens_updated ON public.email_mensagens;
CREATE TRIGGER trg_email_mensagens_updated BEFORE UPDATE ON public.email_mensagens
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
