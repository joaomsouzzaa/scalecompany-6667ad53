-- Opção de envio por E-MAIL nas Notificações (espelha a opção de Google Sheets).
-- Cada notificação pode, além do WhatsApp, disparar um e-mail via SMTP (função `email`)
-- usando uma conta de `email_config`. Assunto/corpo/destinatário aceitam {{variáveis}}.

alter table public.notificacoes add column if not exists email_ativo boolean not null default false;
alter table public.notificacoes add column if not exists email_config_id integer;
alter table public.notificacoes add column if not exists email_para text;     -- destinatários (vírgula); aceita {{email}}
alter table public.notificacoes add column if not exists email_assunto text;   -- título do e-mail
alter table public.notificacoes add column if not exists email_corpo text;     -- corpo (HTML simples / texto)
