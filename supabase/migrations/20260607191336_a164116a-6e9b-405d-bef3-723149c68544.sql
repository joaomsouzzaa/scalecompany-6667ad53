create table if not exists public.tarefa_anexos (
  id uuid primary key default gen_random_uuid(),
  tarefa_id uuid not null references public.tarefas(id) on delete cascade,
  tipo text not null default 'imagem',
  url text not null,
  prompt text,
  origem text not null default 'higgsfield',
  status text not null default 'pronto',
  created_at timestamptz not null default now()
);

grant select, insert, update, delete on public.tarefa_anexos to anon, authenticated;
grant all on public.tarefa_anexos to service_role;

create index if not exists tarefa_anexos_tarefa_id_idx on public.tarefa_anexos(tarefa_id);

alter table public.tarefa_anexos enable row level security;

drop policy if exists "tarefa_anexos_all" on public.tarefa_anexos;
create policy "tarefa_anexos_all" on public.tarefa_anexos
  for all using (true) with check (true);