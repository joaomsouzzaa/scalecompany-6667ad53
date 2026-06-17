-- Pool ÚNICO de instâncias UAZAPI, compartilhado por Notificações e Cobrança.
-- A URL do servidor e o admin token vêm de secrets (UAZAPI_SERVER_URL / UAZAPI_ADMIN_TOKEN);
-- aqui guardamos só as instâncias (nome + token da instância + status).

create table if not exists public.uazapi_instancias (
  id uuid primary key default gen_random_uuid(),
  nome text not null unique,
  instance_token text,
  status text default 'desconectado',
  numero text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

grant select, insert, update, delete on public.uazapi_instancias to anon, authenticated;
grant all on public.uazapi_instancias to service_role;
alter table public.uazapi_instancias enable row level security;
drop policy if exists "uazapi_instancias_all" on public.uazapi_instancias;
create policy "uazapi_instancias_all" on public.uazapi_instancias for all to anon, authenticated using (true) with check (true);

-- Qual instância cada notificação usa para enviar.
alter table public.notificacoes add column if not exists instancia text;

-- Qual instância um lote de cobrança usou (escolhida na conferência).
alter table public.cobranca_disparos add column if not exists instancia text;

-- Backfill: traz as instâncias já existentes (config singleton) para o pool.
insert into public.uazapi_instancias (nome, instance_token, status, numero)
  select instance, instance_token, status, numero from public.whatsapp_config
  where instance is not null and instance <> ''
  on conflict (nome) do nothing;

insert into public.uazapi_instancias (nome, instance_token, status, numero)
  select instance, instance_token, status, numero from public.cobranca_whatsapp_config
  where instance is not null and instance <> ''
  on conflict (nome) do nothing;
