-- Integração Google Sheets: credenciais OAuth + tokens (linha única).
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
-- Frontend só precisa saber se está conectado (email) e gravar client_id/secret;
-- tokens são lidos/gravados pelo service_role na edge function.
drop policy if exists "google_config_all" on public.google_config;
create policy "google_config_all" on public.google_config for all to anon, authenticated using (true) with check (true);

-- Config de Sheets por notificação.
alter table public.notificacoes add column if not exists sheets_ativo boolean not null default false;
alter table public.notificacoes add column if not exists sheets_spreadsheet_id text;
alter table public.notificacoes add column if not exists sheets_spreadsheet_nome text;
alter table public.notificacoes add column if not exists sheets_aba text;
alter table public.notificacoes add column if not exists sheets_mapa jsonb not null default '{}'::jsonb; -- { "Coluna": "{{variavel}}" }
