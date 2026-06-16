-- Módulo E-mail (Eventos): conexão à conta de e-mail do cPanel (IMAP leitura /
-- SMTP envio), captura diária de e-mails relevantes (últimas 72h) e geração de
-- rascunhos de resposta via OpenAI, com aprovação humana.

-- ===================================================================
-- Config (singleton id=1): credenciais cPanel + destino do relatório
-- ===================================================================
create table if not exists public.email_config (
  id int primary key default 1,
  imap_host text,
  imap_port int not null default 993,
  smtp_host text,
  smtp_port int not null default 465,
  email_usuario text,          -- e-mail completo (login)
  senha text,                  -- senha da conta (RLS controla acesso)
  whatsapp_destino text,       -- número que recebe o relatório (usa whatsapp_config p/ enviar)
  keywords text[] not null default array[
    'workshop','workshop scale','cancelamento','cancelar','reembolso','estorno',
    'devolução','desistência','troca de ingresso','transferência','nota fiscal',
    'comprovante','pagamento','ingresso','inscrição','dúvida','reclamação'
  ]::text[],
  ativo boolean not null default true,
  ultima_execucao timestamptz,
  updated_at timestamptz not null default now(),
  constraint email_config_singleton check (id = 1)
);
insert into public.email_config (id) values (1) on conflict (id) do nothing;

alter table public.email_config enable row level security;
grant select, insert, update, delete on public.email_config to anon, authenticated;
grant all on public.email_config to service_role;
create policy "email_config_all" on public.email_config
  for all to anon, authenticated using (true) with check (true);

-- ===================================================================
-- E-mails relevantes capturados
-- ===================================================================
create table if not exists public.email_mensagens (
  id uuid primary key default gen_random_uuid(),
  message_id text unique,          -- dedup: só novos
  thread_in_reply_to text,         -- p/ montar reply (In-Reply-To / References)
  remetente text,                  -- endereço de e-mail
  remetente_nome text,
  assunto text,
  recebido_em timestamptz,
  corpo text,                      -- texto extraído do e-mail
  resumo text,                     -- gerado pela IA
  categoria text,                  -- qual keyword bateu
  rascunho_resposta text,          -- gerado pela IA
  status text not null default 'novo',  -- novo | aprovado | respondido | ignorado
  respondido_em timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists email_mensagens_status_idx on public.email_mensagens (status);
create index if not exists email_mensagens_recebido_idx on public.email_mensagens (recebido_em desc);

alter table public.email_mensagens enable row level security;
grant select, insert, update, delete on public.email_mensagens to anon, authenticated;
grant all on public.email_mensagens to service_role;
create policy "email_mensagens_all" on public.email_mensagens
  for all to anon, authenticated using (true) with check (true);
