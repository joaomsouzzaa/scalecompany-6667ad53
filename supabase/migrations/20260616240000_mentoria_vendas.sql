-- ============================================================
-- Vendas de Mentoria (Inside Sales)
-- Recebe webhook dedicado de produtos de mentoria (não ingressos),
-- com colunas mapeáveis e disparo automático de WhatsApp por gatilho.
-- ============================================================

-- mentoria_vendas: uma linha por venda recebida
create table if not exists public.mentoria_vendas (
  id uuid primary key default gen_random_uuid(),
  id_transacao text,
  status text,
  produto text,
  forma_pagamento text,
  telefone text,
  nome text,
  dados jsonb not null default '{}'::jsonb,
  payload jsonb,
  mensagem_enviada boolean not null default false,
  mensagem_status text,
  data_venda timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists mentoria_vendas_transacao_idx on public.mentoria_vendas(id_transacao);
create index if not exists mentoria_vendas_created_idx on public.mentoria_vendas(created_at);
grant select, insert, update, delete on public.mentoria_vendas to anon, authenticated;
grant all on public.mentoria_vendas to service_role;
alter table public.mentoria_vendas enable row level security;
drop policy if exists "mentoria_vendas_all" on public.mentoria_vendas;
create policy "mentoria_vendas_all" on public.mentoria_vendas for all to anon, authenticated using (true) with check (true);

-- mentoria_campos: definição das colunas / mapeamento de campos do payload
create table if not exists public.mentoria_campos (
  id uuid primary key default gen_random_uuid(),
  ordem int not null default 0,
  label text not null,
  caminho text not null,
  tipo text not null default 'texto',
  ativo boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists mentoria_campos_ordem_idx on public.mentoria_campos(ordem);
grant select, insert, update, delete on public.mentoria_campos to anon, authenticated;
grant all on public.mentoria_campos to service_role;
alter table public.mentoria_campos enable row level security;
drop policy if exists "mentoria_campos_all" on public.mentoria_campos;
create policy "mentoria_campos_all" on public.mentoria_campos for all to anon, authenticated using (true) with check (true);

-- mentoria_gatilhos: regras de mensagem por produto + forma de pagamento
create table if not exists public.mentoria_gatilhos (
  id uuid primary key default gen_random_uuid(),
  nome text,
  produto text,
  forma_pagamento text,
  mensagem text not null,
  prioridade int not null default 0,
  ativo boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists mentoria_gatilhos_prioridade_idx on public.mentoria_gatilhos(prioridade desc);
grant select, insert, update, delete on public.mentoria_gatilhos to anon, authenticated;
grant all on public.mentoria_gatilhos to service_role;
alter table public.mentoria_gatilhos enable row level security;
drop policy if exists "mentoria_gatilhos_all" on public.mentoria_gatilhos;
create policy "mentoria_gatilhos_all" on public.mentoria_gatilhos for all to anon, authenticated using (true) with check (true);
