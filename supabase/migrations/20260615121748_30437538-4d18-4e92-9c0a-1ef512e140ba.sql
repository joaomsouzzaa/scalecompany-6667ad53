
-- cobranca_whatsapp_config
create table if not exists public.cobranca_whatsapp_config (
  id int primary key default 1,
  server_url text,
  admin_token text,
  instance text,
  instance_token text,
  status text,
  numero text,
  updated_at timestamptz not null default now(),
  constraint cobranca_whatsapp_config_singleton check (id = 1)
);
insert into public.cobranca_whatsapp_config (id) values (1) on conflict (id) do nothing;
grant select, insert, update, delete on public.cobranca_whatsapp_config to anon, authenticated;
grant all on public.cobranca_whatsapp_config to service_role;
alter table public.cobranca_whatsapp_config enable row level security;
drop policy if exists "cobranca_whatsapp_config_all" on public.cobranca_whatsapp_config;
create policy "cobranca_whatsapp_config_all" on public.cobranca_whatsapp_config for all to anon, authenticated using (true) with check (true);

-- cobranca_mensagens
create table if not exists public.cobranca_mensagens (
  id uuid primary key default gen_random_uuid(),
  ordem int not null default 0,
  nome text,
  mensagem text not null,
  ativo boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists cobranca_mensagens_ordem_idx on public.cobranca_mensagens(ordem);
grant select, insert, update, delete on public.cobranca_mensagens to anon, authenticated;
grant all on public.cobranca_mensagens to service_role;
alter table public.cobranca_mensagens enable row level security;
drop policy if exists "cobranca_mensagens_all" on public.cobranca_mensagens;
create policy "cobranca_mensagens_all" on public.cobranca_mensagens for all to anon, authenticated using (true) with check (true);

-- cobranca_contatos
create table if not exists public.cobranca_contatos (
  id uuid primary key default gen_random_uuid(),
  telefone text not null unique,
  nome text,
  dados jsonb not null default '{}'::jsonb,
  ultima_ordem_enviada int,
  ultima_mensagem text,
  ultima_enviada_em timestamptz,
  updated_at timestamptz not null default now()
);
grant select, insert, update, delete on public.cobranca_contatos to anon, authenticated;
grant all on public.cobranca_contatos to service_role;
alter table public.cobranca_contatos enable row level security;
drop policy if exists "cobranca_contatos_all" on public.cobranca_contatos;
create policy "cobranca_contatos_all" on public.cobranca_contatos for all to anon, authenticated using (true) with check (true);

-- cobranca_disparos
create table if not exists public.cobranca_disparos (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'pendente',
  total int not null default 0,
  enviados int not null default 0,
  erros int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant select, insert, update, delete on public.cobranca_disparos to anon, authenticated;
grant all on public.cobranca_disparos to service_role;
alter table public.cobranca_disparos enable row level security;
drop policy if exists "cobranca_disparos_all" on public.cobranca_disparos;
create policy "cobranca_disparos_all" on public.cobranca_disparos for all to anon, authenticated using (true) with check (true);

-- cobranca_disparo_itens
create table if not exists public.cobranca_disparo_itens (
  id uuid primary key default gen_random_uuid(),
  disparo_id uuid not null references public.cobranca_disparos(id) on delete cascade,
  telefone text not null,
  nome text,
  mensagem text,
  ordem int,
  status text not null default 'pendente',
  erro text,
  enviado_em timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists cobranca_disparo_itens_disparo_idx on public.cobranca_disparo_itens(disparo_id);
create index if not exists cobranca_disparo_itens_status_idx on public.cobranca_disparo_itens(status);
grant select, insert, update, delete on public.cobranca_disparo_itens to anon, authenticated;
grant all on public.cobranca_disparo_itens to service_role;
alter table public.cobranca_disparo_itens enable row level security;
drop policy if exists "cobranca_disparo_itens_all" on public.cobranca_disparo_itens;
create policy "cobranca_disparo_itens_all" on public.cobranca_disparo_itens for all to anon, authenticated using (true) with check (true);
