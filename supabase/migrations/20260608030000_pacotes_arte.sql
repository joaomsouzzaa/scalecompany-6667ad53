-- Gerador de pacotes de artes: layouts validados com campos dinâmicos
-- (cidade/data/horário/local) preenchidos na geração.
create table if not exists public.pacotes_arte (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  descricao text,
  created_at timestamptz not null default now()
);

create table if not exists public.pacote_artes (
  id uuid primary key default gen_random_uuid(),
  pacote_id uuid not null references public.pacotes_arte(id) on delete cascade,
  url text not null,                    -- imagem base do layout
  ordem int not null default 0,
  campos jsonb not null default '[]'::jsonb, -- [{tipo,x,y,fontSize,color,fontFamily,align,bold}]
  created_at timestamptz not null default now()
);
create index if not exists pacote_artes_pacote_id_idx on public.pacote_artes(pacote_id);

create table if not exists public.pacote_geracoes (
  id uuid primary key default gen_random_uuid(),
  pacote_id uuid references public.pacotes_arte(id) on delete set null,
  pacote_nome text,
  valores jsonb not null default '{}'::jsonb, -- {cidade,data,horario,local}
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

-- Buckets: artes-base (templates) e pacotes-gerados (zips do histórico).
insert into storage.buckets (id, name, public) values ('artes-base', 'artes-base', true) on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('pacotes-gerados', 'pacotes-gerados', true) on conflict (id) do nothing;
drop policy if exists "artes_base_read" on storage.objects;
create policy "artes_base_read" on storage.objects for select using (bucket_id in ('artes-base','pacotes-gerados'));
drop policy if exists "artes_base_write" on storage.objects;
create policy "artes_base_write" on storage.objects for insert to anon, authenticated with check (bucket_id in ('artes-base','pacotes-gerados'));
