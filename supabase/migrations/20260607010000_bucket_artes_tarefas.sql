-- Bucket público para as artes geradas (necessário p/ OpenAI, que devolve base64).
insert into storage.buckets (id, name, public)
values ('artes-tarefas', 'artes-tarefas', true)
on conflict (id) do nothing;

-- Leitura pública (o bucket já é public, mas garante a policy de SELECT).
drop policy if exists "artes_tarefas_read" on storage.objects;
create policy "artes_tarefas_read" on storage.objects
  for select using (bucket_id = 'artes-tarefas');
