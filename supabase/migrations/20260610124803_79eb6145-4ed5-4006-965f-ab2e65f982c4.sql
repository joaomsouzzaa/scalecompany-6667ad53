-- Base de Conhecimento: repositórios consultados por todos os agentes
create table if not exists public.base_conhecimento (
  id uuid primary key default gen_random_uuid(),
  titulo text not null,
  conteudo text not null default '',
  ativo boolean not null default true,
  ordem int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

grant select, insert, update, delete on public.base_conhecimento to anon, authenticated, service_role;
alter table public.base_conhecimento enable row level security;

drop policy if exists "base_conhecimento_all" on public.base_conhecimento;
create policy "base_conhecimento_all" on public.base_conhecimento for all to anon, authenticated using (true) with check (true);

-- Lixeira do Workflow: soft delete recuperável
alter table public.tarefas add column if not exists deleted_at timestamptz;
create index if not exists tarefas_deleted_at_idx on public.tarefas (deleted_at);