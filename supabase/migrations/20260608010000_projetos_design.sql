-- Repositório de Projetos (Designer): marcas, referências e identidade visual.
create table if not exists public.projetos_design (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  descricao text,
  cores text,                                   -- ex.: "preto, vermelho, branco"
  logo_posicao text not null default 'baixo-centro', -- 'cima-centro' | 'baixo-centro'
  created_at timestamptz not null default now()
);

create table if not exists public.projeto_assets (
  id uuid primary key default gen_random_uuid(),
  projeto_id uuid not null references public.projetos_design(id) on delete cascade,
  tipo text not null default 'referencia',      -- 'logo' | 'referencia' | 'identidade'
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

-- Bucket público para os materiais dos projetos.
insert into storage.buckets (id, name, public)
values ('projeto-assets', 'projeto-assets', true)
on conflict (id) do nothing;
drop policy if exists "projeto_assets_read" on storage.objects;
create policy "projeto_assets_read" on storage.objects for select using (bucket_id = 'projeto-assets');
drop policy if exists "projeto_assets_write" on storage.objects;
create policy "projeto_assets_write" on storage.objects for insert to anon, authenticated with check (bucket_id = 'projeto-assets');
