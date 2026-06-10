-- Lixeira do Workflow: exclusão vira "soft delete" (recuperável).
-- Tarefas com deleted_at preenchido ficam na lixeira; null = ativa.
alter table public.tarefas add column if not exists deleted_at timestamptz;
create index if not exists tarefas_deleted_at_idx on public.tarefas (deleted_at);
