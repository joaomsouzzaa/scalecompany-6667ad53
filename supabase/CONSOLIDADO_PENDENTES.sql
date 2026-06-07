-- ============================================================
-- SQL CONSOLIDADO — features recentes (idempotente, pode rodar 1x)
-- Designer (projetos), Pacotes de Artes, Google Sheets, logs, anexos
-- ============================================================

-- ---------- tarefa_anexos (artes geradas no card de Design) ----------
create table if not exists public.tarefa_anexos (
  id uuid primary key default gen_random_uuid(),
  tarefa_id uuid not null references public.tarefas(id) on delete cascade,
  tipo text not null default 'imagem',
  url text,
  prompt text,
  origem text not null default 'higgsfield',
  status text not null default 'pronto',
  created_at timestamptz not null default now()
);
alter table public.tarefa_anexos alter column url drop not null;
create index if not exists tarefa_anexos_tarefa_id_idx on public.tarefa_anexos(tarefa_id);
alter table public.tarefa_anexos enable row level security;
grant select, insert, update, delete on public.tarefa_anexos to anon, authenticated, service_role;
drop policy if exists "tarefa_anexos_all" on public.tarefa_anexos;
create policy "tarefa_anexos_all" on public.tarefa_anexos for all to anon, authenticated using (true) with check (true);

-- ---------- notificacao_logs: coluna cidade ----------
alter table public.notificacao_logs add column if not exists cidade text;
grant select on public.notificacao_logs to anon, authenticated, service_role;
alter table public.notificacao_logs enable row level security;
drop policy if exists "notificacao_logs_read" on public.notificacao_logs;
create policy "notificacao_logs_read" on public.notificacao_logs for select to anon, authenticated using (true);

-- ---------- Repositório de Projetos (Designer) ----------
create table if not exists public.projetos_design (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  descricao text,
  cores text,
  logo_posicao text not null default 'baixo-centro',
  palavras_chave text,
  created_at timestamptz not null default now()
);
alter table public.projetos_design add column if not exists palavras_chave text;

create table if not exists public.projeto_assets (
  id uuid primary key default gen_random_uuid(),
  projeto_id uuid not null references public.projetos_design(id) on delete cascade,
  tipo text not null default 'referencia',
  url text not null,
  descricao text,
  created_at timestamptz not null default now()
);
create index if not exists projeto_assets_projeto_id_idx on public.projeto_assets(projeto_id);

alter table public.projetos_design enable row level security;
alter table public.projeto_assets enable row level security;
grant select, insert, update, delete on public.projetos_design to anon, authenticated, service_role;
grant select, insert, update, delete on public.projeto_assets to anon, authenticated, service_role;
drop policy if exists "projetos_design_all" on public.projetos_design;
create policy "projetos_design_all" on public.projetos_design for all to anon, authenticated using (true) with check (true);
drop policy if exists "projeto_assets_all" on public.projeto_assets;
create policy "projeto_assets_all" on public.projeto_assets for all to anon, authenticated using (true) with check (true);

-- ---------- Pacotes de Artes ----------
create table if not exists public.pacotes_arte (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  descricao text,
  created_at timestamptz not null default now()
);
create table if not exists public.pacote_artes (
  id uuid primary key default gen_random_uuid(),
  pacote_id uuid not null references public.pacotes_arte(id) on delete cascade,
  url text not null,
  ordem int not null default 0,
  campos jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists pacote_artes_pacote_id_idx on public.pacote_artes(pacote_id);
create table if not exists public.pacote_geracoes (
  id uuid primary key default gen_random_uuid(),
  pacote_id uuid references public.pacotes_arte(id) on delete set null,
  pacote_nome text,
  valores jsonb not null default '{}'::jsonb,
  zip_url text,
  qtd int not null default 0,
  created_at timestamptz not null default now()
);
alter table public.pacotes_arte enable row level security;
alter table public.pacote_artes enable row level security;
alter table public.pacote_geracoes enable row level security;
grant select, insert, update, delete on public.pacotes_arte to anon, authenticated, service_role;
grant select, insert, update, delete on public.pacote_artes to anon, authenticated, service_role;
grant select, insert, update, delete on public.pacote_geracoes to anon, authenticated, service_role;
drop policy if exists "pacotes_arte_all" on public.pacotes_arte;
create policy "pacotes_arte_all" on public.pacotes_arte for all to anon, authenticated using (true) with check (true);
drop policy if exists "pacote_artes_all" on public.pacote_artes;
create policy "pacote_artes_all" on public.pacote_artes for all to anon, authenticated using (true) with check (true);
drop policy if exists "pacote_geracoes_all" on public.pacote_geracoes;
create policy "pacote_geracoes_all" on public.pacote_geracoes for all to anon, authenticated using (true) with check (true);

-- ---------- Google Sheets ----------
create table if not exists public.google_config (
  id int primary key default 1,
  client_id text,
  client_secret text,
  access_token text,
  refresh_token text,
  token_expiry timestamptz,
  email text,
  updated_at timestamptz not null default now(),
  constraint google_config_singleton check (id = 1)
);
insert into public.google_config (id) values (1) on conflict (id) do nothing;
alter table public.google_config enable row level security;
grant select, insert, update on public.google_config to anon, authenticated, service_role;
drop policy if exists "google_config_all" on public.google_config;
create policy "google_config_all" on public.google_config for all to anon, authenticated using (true) with check (true);

alter table public.notificacoes add column if not exists sheets_ativo boolean not null default false;
alter table public.notificacoes add column if not exists sheets_spreadsheet_id text;
alter table public.notificacoes add column if not exists sheets_spreadsheet_nome text;
alter table public.notificacoes add column if not exists sheets_aba text;
alter table public.notificacoes add column if not exists sheets_mapa jsonb not null default '{}'::jsonb;

-- ---------- Storage buckets (públicos) ----------
insert into storage.buckets (id, name, public) values ('artes-tarefas', 'artes-tarefas', true) on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('projeto-assets', 'projeto-assets', true) on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('artes-base', 'artes-base', true) on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('pacotes-gerados', 'pacotes-gerados', true) on conflict (id) do nothing;

drop policy if exists "buckets_publicos_read" on storage.objects;
create policy "buckets_publicos_read" on storage.objects for select
  using (bucket_id in ('artes-tarefas','projeto-assets','artes-base','pacotes-gerados'));
drop policy if exists "buckets_publicos_write" on storage.objects;
create policy "buckets_publicos_write" on storage.objects for insert to anon, authenticated
  with check (bucket_id in ('artes-tarefas','projeto-assets','artes-base','pacotes-gerados'));
